import { formBody, NetworkError, parseRetryAfterMs, requestJson } from './http.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_MESSAGES_PER_CHECK = 500;

/** Read-only is the narrowest Gmail scope that supports search queries. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export class GmailError extends Error {
  /** kind: 'auth' (reconnect needed) | 'retry' (temporary) | 'config' */
  constructor(kind, message, { retryAfterMs = null } = {}) {
    super(message);
    this.name = 'GmailError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export class GmailClient {
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

  isConfigured() {
    return Boolean(this.#clientId && this.#clientSecret);
  }

  authorizationUrl(state, codeChallenge) {
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode(code, codeVerifier) {
    const token = await this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.#redirectUri,
    });
    const scopes = (token.scope ?? '').split(' ');
    if (!scopes.includes(GMAIL_SCOPE)) {
      throw new GmailError('auth', 'Gmail read access was not granted. Reconnect and allow ListRelay to read your email.');
    }
    if (!token.refresh_token) {
      throw new GmailError('auth', 'Google did not return a refresh token. Remove ListRelay from your Google account permissions and reconnect.');
    }
    return toCredential(token);
  }

  async getProfile() {
    return this.#api('/profile');
  }

  async listMessageIds(query) {
    const ids = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ q: query, maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.#api(`/messages?${params}`);
      for (const message of page.messages ?? []) ids.push(message.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < MAX_MESSAGES_PER_CHECK);
    return ids;
  }

  /** Returns only the metadata ListRelay needs, or null if the message no longer exists. */
  async getMessageMeta(id) {
    const params = new URLSearchParams({ format: 'metadata' });
    params.append('metadataHeaders', 'Subject');
    params.append('metadataHeaders', 'From');
    let message;
    try {
      message = await this.#api(`/messages/${encodeURIComponent(id)}?${params}`);
    } catch (err) {
      if (err.notFound) return null;
      throw err;
    }
    const header = (name) =>
      message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
    return {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds ?? [],
      internalDate: Number(message.internalDate),
      subject: header('Subject'),
      from: header('From'),
    };
  }

  async revoke() {
    const credential = this.#store.getCredential('google');
    const token = credential?.refresh_token ?? credential?.access_token;
    if (!token) return;
    await requestJson(this.#fetch, REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ token }),
    }).catch(() => {});
  }

  async #accessToken({ forceRefresh = false } = {}) {
    const credential = this.#store.getCredential('google');
    if (!credential) throw new GmailError('auth', 'Gmail is not connected.');
    if (!forceRefresh && credential.expires_at > Date.now() + 60_000) return credential.access_token;
    if (!this.isConfigured()) throw new GmailError('config', 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.');
    const token = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: credential.refresh_token });
    const refreshed = { ...toCredential(token), refresh_token: token.refresh_token ?? credential.refresh_token };
    this.#store.setCredential('google', refreshed);
    return refreshed.access_token;
  }

  async #tokenRequest(params) {
    let response;
    try {
      response = await requestJson(this.#fetch, TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ client_id: this.#clientId, client_secret: this.#clientSecret, ...params }),
      });
    } catch (err) {
      throw new GmailError('retry', `Could not reach Google: ${err.message}`);
    }
    if (response.status === 200 && response.json?.access_token) return response.json;
    const code = response.json?.error;
    if (code === 'invalid_grant' || code === 'unauthorized_client' || code === 'invalid_client') {
      throw new GmailError('auth', 'Gmail authorization expired or was revoked. Reconnect Gmail.');
    }
    throw new GmailError('retry', `Google token request failed (HTTP ${response.status}${code ? `, ${code}` : ''}).`, {
      retryAfterMs: parseRetryAfterMs(response.headers),
    });
  }

  async #api(path, { retried = false } = {}) {
    const token = await this.#accessToken({ forceRefresh: retried });
    let response;
    try {
      response = await requestJson(this.#fetch, `${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new GmailError('retry', err instanceof NetworkError ? `Could not reach Gmail: ${err.message}` : err.message);
    }
    if (response.status === 200) return response.json;
    if (response.status === 401 && !retried) return this.#api(path, { retried: true });

    const reason = response.json?.error?.errors?.[0]?.reason ?? response.json?.error?.status ?? '';
    if (response.status === 404) {
      const err = new GmailError('retry', 'Gmail message not found.');
      err.notFound = true;
      throw err;
    }
    if (response.status === 401 || (response.status === 403 && /insufficient|forbidden|PERMISSION_DENIED/i.test(reason))) {
      throw new GmailError('auth', 'Gmail access was denied. Reconnect Gmail.');
    }
    throw new GmailError('retry', `Gmail request failed (HTTP ${response.status}${reason ? `, ${reason}` : ''}).`, {
      retryAfterMs: parseRetryAfterMs(response.headers),
    });
  }
}

function toCredential(token) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? null,
    expires_at: Date.now() + Number(token.expires_in ?? 3600) * 1000,
    scope: token.scope ?? null,
  };
}
