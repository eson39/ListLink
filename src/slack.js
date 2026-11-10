import { formBody, NetworkError, parseRetryAfterMs, requestJson } from './http.js';

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const API_BASE = 'https://slack.com/api';

/** chat:write posts as the user; the read scopes only list channels the user belongs to. */
export const SLACK_USER_SCOPES = ['chat:write', 'channels:read', 'groups:read'];

const AUTH_ERRORS = new Set([
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'missing_scope',
  'no_permission',
  'not_allowed_token_type',
  'team_access_not_granted',
  'org_login_required',
  'two_factor_setup_required',
  'invalid_refresh_token',
]);

const CHANNEL_ERRORS = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'restricted_action',
  'restricted_action_read_only_channel',
  'restricted_action_thread_only_channel',
  'restricted_action_non_threadable_channel',
  'ekm_access_denied',
  'access_denied',
  'team_not_found',
]);

const RETRY_ERRORS = new Set(['ratelimited', 'rate_limited', 'service_unavailable', 'request_timeout']);

/** Slack documents these as possibly having partially succeeded. */
const UNCERTAIN_ERRORS = new Set(['internal_error', 'fatal_error']);

const ERROR_HINTS = {
  not_in_channel: 'You are not a member of the selected channel. Join it in Slack or choose another channel.',
  channel_not_found: 'The selected channel was not found or is not visible to your account.',
  is_archived: 'The selected channel is archived.',
  restricted_action: 'Workspace settings prevent your account from posting in this channel.',
  missing_scope: 'Slack authorization is missing the chat:write permission. Reconnect Slack.',
  token_revoked: 'Slack authorization was revoked. Reconnect Slack.',
  token_expired: 'Slack authorization expired. Reconnect Slack.',
  invalid_auth: 'Slack authorization is no longer valid. Reconnect Slack.',
  account_inactive: 'Your Slack account is deactivated or the authorization was removed. Reconnect Slack.',
};

export class SlackError extends Error {
  /** kind: 'auth' | 'channel' | 'retry' | 'uncertain' | 'fatal' */
  constructor(kind, code, message, { retryAfterMs = null } = {}) {
    super(message);
    this.name = 'SlackError';
    this.kind = kind;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export function classifySlackFailure({ status, error, retryAfterMs = null }) {
  const code = error ?? `http_${status}`;
  const hint = ERROR_HINTS[code];
  if (status === 429 || RETRY_ERRORS.has(code)) {
    return new SlackError('retry', code, 'Slack rate limit or temporary outage; will retry.', { retryAfterMs });
  }
  if (AUTH_ERRORS.has(code) || status === 401) {
    return new SlackError('auth', code, hint ?? `Slack rejected the authorization (${code}). Reconnect Slack.`);
  }
  if (CHANNEL_ERRORS.has(code) || code.startsWith('restricted_action')) {
    return new SlackError('channel', code, hint ?? `Cannot post to the selected channel (${code}).`);
  }
  if (UNCERTAIN_ERRORS.has(code) || (status >= 500 && status !== 503)) {
    return new SlackError('uncertain', code, `Slack returned ${code}; the message may or may not have been posted.`);
  }
  if (status === 503) {
    return new SlackError('retry', code, 'Slack is temporarily unavailable; will retry.', { retryAfterMs });
  }
  return new SlackError('fatal', code, `Slack rejected the message (${code}).`);
}

export class SlackClient {
  #clientId;
  #clientSecret;
  #redirectUri;
  #store;
  #fetch;

  constructor({ clientId, clientSecret, redirectUri, store, fetchImpl = fetch }) {
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#redirectUri = redirectUri;
    this.#store = store;
    this.#fetch = fetchImpl;
  }

  isOAuthConfigured() {
    return Boolean(this.#clientId && this.#clientSecret);
  }

  authorizationUrl(state) {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.#clientId,
      user_scope: SLACK_USER_SCOPES.join(','),
      redirect_uri: this.#redirectUri,
      state,
    }).toString();
    return url.toString();
  }

  /** Completes OAuth. Only a user token is accepted; ListRelay never posts as a bot. */
  async exchangeCode(code) {
    const result = await this.#call('oauth.v2.access', {
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      code,
      redirect_uri: this.#redirectUri,
    }, { token: null });
    const user = result.authed_user;
    if (!user?.access_token || (user.token_type && user.token_type !== 'user')) {
      throw new SlackError('auth', 'no_user_token', 'Slack did not grant a user token, so ListRelay cannot post as you.');
    }
    return toCredential(user);
  }

  /** Validates a token and returns the identity and scopes it carries. */
  async inspectToken(token) {
    const { json, headers } = await this.#call('auth.test', {}, { token, raw: true });
    const scopes = (headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
      userId: json.user_id,
      userName: json.user,
      teamId: json.team_id,
      teamName: json.team,
      teamUrl: json.url ?? null,
      isBot: Boolean(json.bot_id),
      scopes,
    };
  }

  async listMemberChannels() {
    const channels = [];
    let cursor;
    do {
      const page = await this.#call('users.conversations', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const channel of page.channels ?? []) {
        channels.push({ id: channel.id, name: channel.name, isPrivate: Boolean(channel.is_private) });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor && channels.length < 2000);
    return channels.sort((a, b) => a.name.localeCompare(b.name));
  }

  async postMessage(channel, text) {
    const result = await this.#call('chat.postMessage', {
      channel,
      text,
      mrkdwn: false,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ts: result.ts, channel: result.channel, user: result.message?.user ?? null };
  }

  async revoke() {
    await this.#call('auth.revoke', {}).catch(() => {});
  }

  async #accessToken() {
    const credential = this.#store.getCredential('slack');
    if (!credential) throw new SlackError('auth', 'not_connected', 'Slack is not connected.');
    if (!credential.expires_at || credential.expires_at > Date.now() + 60_000) return credential.access_token;
    if (!credential.refresh_token || !this.isOAuthConfigured()) {
      throw new SlackError('auth', 'token_expired', ERROR_HINTS.token_expired);
    }
    const result = await this.#call('oauth.v2.access', {
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: 'refresh_token',
      refresh_token: credential.refresh_token,
    }, { token: null });
    const refreshed = toCredential(result.authed_user?.access_token ? result.authed_user : result);
    this.#store.setCredential('slack', { ...refreshed, refresh_token: refreshed.refresh_token ?? credential.refresh_token });
    return refreshed.access_token;
  }

  async #call(method, params, { token, raw = false } = {}) {
    const bearer = token === undefined ? await this.#accessToken() : token;
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let response;
    try {
      response = await requestJson(this.#fetch, `${API_BASE}/${method}`, {
        method: 'POST',
        headers,
        body: formBody(params),
      });
    } catch (err) {
      if (err instanceof NetworkError && !err.maybeDelivered) {
        throw new SlackError('retry', 'network', `Could not reach Slack (${err.message}); will retry.`);
      }
      throw new SlackError('uncertain', 'timeout', `No response from Slack (${err.message}); the message may or may not have been posted.`);
    }
    if (response.status === 200 && response.json?.ok) return raw ? response : response.json;
    throw classifySlackFailure({
      status: response.status,
      error: response.json?.error,
      retryAfterMs: parseRetryAfterMs(response.headers),
    });
  }
}

function toCredential(token) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? null,
    expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null,
    scope: token.scope ?? null,
  };
}
