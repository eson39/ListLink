import crypto from 'node:crypto';
import { SLACK_USER_SCOPES } from './slack.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const USER_TOKEN_PATTERN = /^(xoxe\.)?xoxp-[A-Za-z0-9-]+$/;

export function createApp({ config, store, relay, gmail, slack }) {
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const oauthStates = new Map();
  const baseOrigin = new URL(config.baseUrl);
  const allowedHosts = new Set([baseOrigin.host, `localhost:${config.port}`, `127.0.0.1:${config.port}`]);
  let flash = null;
  let channelCache = null;

  const notify = (kind, text) => {
    flash = { kind, text };
  };
  const event = (level, message) => store.addEvent(level, message, Date.now());

  async function memberChannels({ force = false } = {}) {
    if (!store.getSettings().slack_user_id) return { channels: [] };
    if (!force && channelCache && Date.now() - channelCache.at < CHANNEL_CACHE_TTL_MS) return channelCache;
    try {
      channelCache = { at: Date.now(), channels: await slack.listMemberChannels() };
    } catch (err) {
      channelCache = { at: Date.now(), channels: [], error: err.message };
    }
    return channelCache;
  }

  function newOAuthState(provider, extra = {}) {
    const now = Date.now();
    for (const [key, value] of oauthStates) if (value.expiresAt < now) oauthStates.delete(key);
    const state = crypto.randomBytes(24).toString('base64url');
    oauthStates.set(state, { provider, expiresAt: now + OAUTH_STATE_TTL_MS, ...extra });
    return state;
  }

  function takeOAuthState(state, provider) {
    const entry = state ? oauthStates.get(state) : null;
    if (state) oauthStates.delete(state);
    return entry && entry.provider === provider && entry.expiresAt > Date.now() ? entry : null;
  }

  async function connectSlack(credential, identity) {
    if (identity.isBot) throw new Error('That is a bot token. ListRelay only posts as your own user account.');
    const missing = SLACK_USER_SCOPES.filter((scope) => !identity.scopes.includes(scope));
    if (missing.length) throw new Error(`The Slack token is missing required user scopes: ${missing.join(', ')}.`);
    const settings = store.getSettings();
    const changed = settings.slack_user_id && (settings.slack_user_id !== identity.userId || settings.slack_team_id !== identity.teamId);
    if (changed) relay.disable('Automation turned off because a different Slack account was connected.');
    store.setCredential('slack', credential);
    store.updateSettings({
      slack_team_id: identity.teamId,
      slack_team_name: identity.teamName,
      slack_team_url: identity.teamUrl,
      slack_user_id: identity.userId,
      slack_user_name: identity.userName,
      slack_state: 'ok',
      slack_error: null,
      ...(changed ? { slack_channel_id: null, slack_channel_name: null } : {}),
    });
    channelCache = null;
    event('info', `Slack connected as @${identity.userName} in ${identity.teamName}.`);
    if (settings.enabled && !changed) relay.kick();
  }

  const routes = {
    'GET /': async (req, res, url) => {
      const settings = store.getSettings();
      const channels = settings.slack_user_id ? await memberChannels({ force: url.searchParams.has('refresh') }) : null;
      const message = flash;
      flash = null;
      sendHtml(res, 200, renderPage({ settings, channels, flash: message, csrfToken, relay, store, gmail, slack, config }));
    },

    'GET /app.css': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(STYLES);
    },

    'GET /connect/google': (req, res) => {
      if (!gmail.isConfigured()) {
        notify('error', 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart ListRelay.');
        return redirect(res, '/');
      }
      const verifier = crypto.randomBytes(48).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      redirect(res, gmail.authorizationUrl(newOAuthState('google', { verifier }), challenge));
    },

    'GET /oauth/google/callback': async (req, res, url) => {
      const entry = takeOAuthState(url.searchParams.get('state'), 'google');
      if (!entry) {
        notify('error', 'The Gmail connection request expired or was invalid. Try again.');
        return redirect(res, '/');
      }
      if (url.searchParams.get('error') || !url.searchParams.get('code')) {
        notify('error', `Gmail was not connected (${url.searchParams.get('error') ?? 'no authorization code'}).`);
        return redirect(res, '/');
      }
      const previous = store.getSettings();
      try {
        const credential = await gmail.exchangeCode(url.searchParams.get('code'), entry.verifier);
        store.setCredential('google', credential);
        const profile = await gmail.getProfile();
        const email = profile.emailAddress;
        if (previous.gmail_email && previous.gmail_email.toLowerCase() !== email.toLowerCase()) {
          relay.disable('Automation turned off because a different Gmail account was connected.');
        }
        store.updateSettings({ gmail_email: email, gmail_state: 'ok', gmail_error: null, gmail_failures: 0, gmail_retry_at: null });
        event('info', `Gmail connected: ${email}.`);
        notify('success', `Gmail connected: ${email}.`);
        relay.kick();
      } catch (err) {
        store.deleteCredential('google');
        if (previous.gmail_email) relay.disable('Automation turned off because Gmail could not be reconnected.');
        store.updateSettings({ gmail_email: null });
        notify('error', `Gmail connection failed: ${err.message}`);
      }
      redirect(res, '/');
    },

    'GET /connect/slack': (req, res) => {
      if (!slack.isOAuthConfigured()) {
        notify('error', 'Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in .env (or paste a user token below).');
        return redirect(res, '/');
      }
      redirect(res, slack.authorizationUrl(newOAuthState('slack')));
    },

    'GET /oauth/slack/callback': async (req, res, url) => {
      const entry = takeOAuthState(url.searchParams.get('state'), 'slack');
      if (!entry) {
        notify('error', 'The Slack connection request expired or was invalid. Try again.');
        return redirect(res, '/');
      }
      if (url.searchParams.get('error') || !url.searchParams.get('code')) {
        notify('error', `Slack was not connected (${url.searchParams.get('error') ?? 'no authorization code'}).`);
        return redirect(res, '/');
      }
      try {
        const credential = await slack.exchangeCode(url.searchParams.get('code'));
        await connectSlack(credential, await slack.inspectToken(credential.access_token));
        notify('success', 'Slack connected. Choose a destination channel and save settings.');
      } catch (err) {
        notify('error', `Slack connection failed: ${err.message} Automation stays off until Slack can post as you.`);
      }
      redirect(res, '/');
    },

    'POST /connect/slack/token': async (req, res, url, body) => {
      const token = (body.get('token') ?? '').trim();
      if (!USER_TOKEN_PATTERN.test(token)) {
        notify('error', 'Paste a Slack user token (it starts with xoxp-). Bot tokens are not accepted.');
        return redirect(res, '/');
      }
      try {
        const identity = await slack.inspectToken(token);
        await connectSlack({ access_token: token, refresh_token: null, expires_at: null, scope: identity.scopes.join(',') }, identity);
        notify('success', 'Slack connected. Choose a destination channel and save settings.');
      } catch (err) {
        notify('error', `Slack connection failed: ${err.message}`);
      }
      redirect(res, '/');
    },

    'POST /disconnect/google': async (req, res) => {
      relay.disable('Automation turned off because Gmail was disconnected.');
      await gmail.revoke();
      store.deleteCredential('google');
      store.updateSettings({ gmail_email: null, gmail_state: 'ok', gmail_error: null, gmail_failures: 0, gmail_retry_at: null });
      event('info', 'Gmail disconnected.');
      notify('success', 'Gmail disconnected and access revoked.');
      redirect(res, '/');
    },

    'POST /disconnect/slack': async (req, res) => {
      relay.disable('Automation turned off because Slack was disconnected.');
      await slack.revoke();
      store.deleteCredential('slack');
      store.updateSettings({
        slack_team_id: null,
        slack_team_name: null,
        slack_team_url: null,
        slack_user_id: null,
        slack_user_name: null,
        slack_channel_id: null,
        slack_channel_name: null,
        slack_state: 'ok',
        slack_error: null,
      });
      channelCache = null;
      event('info', 'Slack disconnected.');
      notify('success', 'Slack disconnected and access revoked.');
      redirect(res, '/');
    },

    'POST /settings': async (req, res, url, body) => {
      const settings = store.getSettings();
      const channelId = body.get('channel_id');
      if (!settings.slack_user_id) {
        notify('error', 'Connect Slack before choosing a channel.');
        return redirect(res, '/');
      }
      const { channels, error } = await memberChannels({ force: true });
      const channel = channels.find((c) => c.id === channelId);
      if (!channel) {
        notify('error', error ? `Could not load your Slack channels: ${error}` : 'Choose a channel you are a member of.');
        return redirect(res, '/');
      }
      const patch = { slack_channel_id: channel.id, slack_channel_name: channel.name };
      if (settings.slack_state === 'blocked') Object.assign(patch, { slack_state: 'ok', slack_error: null });
      store.updateSettings(patch);
      if (settings.slack_channel_id !== channel.id) event('info', `Destination channel set to #${channel.name}.`);
      notify('success', 'Settings saved.');
      if (settings.enabled) relay.kick();
      redirect(res, '/');
    },

    'POST /toggle': async (req, res, url, body) => {
      if (body.get('enabled') === 'on') {
        const result = await relay.enable();
        if (result.ok) {
          notify('success', 'Automation is on. New matching emails will be posted to Slack.');
          relay.kick();
        } else {
          notify('error', `Automation is still off. ${result.error}`);
        }
      } else {
        relay.disable();
        notify('success', 'Automation is off. No automatic posts will be made.');
      }
      redirect(res, '/');
    },

    'POST /test': async (req, res, url, body) => {
      const settings = store.getSettings();
      const selected = body.get('channel_id');
      if (selected && selected !== settings.slack_channel_id) {
        notify('error', 'You changed the channel without saving. Save settings before sending a test message.');
        return redirect(res, '/');
      }
      const result = await relay.sendTest();
      if (result.ok) notify('success', `Test message posted to #${settings.slack_channel_name}.`);
      else notify('error', `Test message failed: ${result.error}`);
      redirect(res, '/');
    },

    'POST /deliveries/retry': async (req, res, url, body) => {
      const result = await relay.retryDelivery(Number(body.get('id')));
      notify(result.ok ? 'success' : 'error', result.ok ? 'Posted to Slack.' : `Retry failed: ${result.error}`);
      redirect(res, '/');
    },

    'POST /deliveries/dismiss': (req, res, url, body) => {
      const result = relay.dismissDelivery(Number(body.get('id')));
      if (!result.ok) notify('error', result.error);
      redirect(res, '/');
    },
  };

  return async function handle(req, res) {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return sendText(res, 421, 'Unrecognized host.');
      if (config.appPassword && !passwordMatches(req.headers.authorization, config.appPassword)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ListRelay", charset="UTF-8"' });
        return res.end('Authentication required.');
      }
      const url = new URL(req.url, config.baseUrl);
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return sendText(res, 404, 'Not found.');

      let body = null;
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin !== undefined && !isAllowedOrigin(origin, allowedHosts)) return sendText(res, 403, 'Cross-origin request blocked.');
        body = new URLSearchParams(await readBody(req));
        if (!safeEqual(body.get('csrf') ?? '', csrfToken)) {
          notify('error', 'Your session expired. Please try again.');
          return redirect(res, '/');
        }
      }
      await route(req, res, url, body);
    } catch (err) {
      console.error('Request failed:', err.message);
      if (!res.headersSent) sendText(res, 500, 'Something went wrong. Check the server log.');
    }
  };
}

function isAllowedOrigin(origin, allowedHosts) {
  try {
    return allowedHosts.has(new URL(origin).host);
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function passwordMatches(header, password) {
  const match = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  return safeEqual(decoded.slice(decoded.indexOf(':') + 1), password);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // 'no-referrer' would make browsers send `Origin: null` on our own form posts.
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function formatTime(ms) {
  if (!ms) return 'Never';
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function statusSummary(settings, problems) {
  if (!settings.enabled) {
    return problems.length
      ? { tone: 'muted', text: `Paused — no automatic posts. To finish setup: ${problems.join(' ')}` }
      : { tone: 'muted', text: 'Paused — no automatic posts' };
  }
  if (settings.gmail_state === 'reauth') return { tone: 'error', text: `Paused — reconnect Gmail. ${settings.gmail_error ?? ''}`, action: 'gmail' };
  if (settings.slack_state === 'reauth') return { tone: 'error', text: `Paused — reconnect Slack. ${settings.slack_error ?? ''}`, action: 'slack' };
  if (settings.slack_state === 'blocked') return { tone: 'error', text: `Paused — cannot post to Slack. ${settings.slack_error ?? ''}` };
  if (settings.gmail_state === 'error') {
    return { tone: 'warn', text: `Running — the last Gmail check failed (${settings.gmail_error}). Retrying ${formatTime(settings.gmail_retry_at)}.` };
  }
  return { tone: 'ok', text: `Running — posting new matching emails to #${settings.slack_channel_name}` };
}

const STATUS_LABELS = {
  posted: 'Posted',
  skipped: 'Skipped',
  queued: 'Waiting',
  sending: 'Sending',
  needs_review: 'Needs review',
  failed: 'Failed',
  canceled: 'Canceled',
  dismissed: 'Dismissed',
};

function hiddenCsrf(csrfToken) {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">`;
}

function postButton({ action, label, csrfToken, fields = {}, className = '', disabled = false }) {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
  return `<form method="post" action="${escapeHtml(action)}" class="inline">${hiddenCsrf(csrfToken)}${inputs}<button type="submit" class="${className}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button></form>`;
}

function slackPermalink(settings, row) {
  if (!settings.slack_team_url || !row.slack_ts || !row.slack_channel) return null;
  return `${settings.slack_team_url.replace(/\/+$/, '')}/archives/${encodeURIComponent(row.slack_channel)}/p${row.slack_ts.replace('.', '')}`;
}

function renderActivityRow(item, settings, csrfToken) {
  if (item.type === 'event') {
    return `<tr class="event ${escapeHtml(item.level)}">
      <td class="time">${escapeHtml(formatTime(item.at))}</td>
      <td>${item.level === 'info' ? 'Event' : 'Error'}</td>
      <td colspan="3">${escapeHtml(item.message)}</td>
    </tr>`;
  }
  let status = STATUS_LABELS[item.status] ?? item.status;
  if (item.status === 'queued' && item.retry_count > 0) status = `Retry ${item.retry_count} at ${formatTime(item.next_attempt_at)}`;
  const actions = [];
  if (item.kind === 'email' && ['failed', 'canceled', 'needs_review'].includes(item.status)) {
    actions.push(postButton({ action: '/deliveries/retry', label: item.status === 'needs_review' ? 'Retry anyway' : 'Retry', csrfToken, fields: { id: item.id }, className: 'small' }));
  }
  if (['failed', 'canceled', 'needs_review'].includes(item.status)) {
    actions.push(postButton({ action: '/deliveries/dismiss', label: 'Dismiss', csrfToken, fields: { id: item.id }, className: 'small secondary' }));
  }
  const link = item.status === 'posted' ? slackPermalink(settings, item) : null;
  return `<tr class="delivery ${escapeHtml(item.status)}">
    <td class="time">${escapeHtml(formatTime(item.at))}</td>
    <td>${item.kind === 'test' ? 'Test' : 'Email'}</td>
    <td class="subject">${escapeHtml(item.subject)}</td>
    <td><span class="badge ${escapeHtml(item.status)}">${escapeHtml(status)}</span>${link ? ` <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">View</a>` : ''}</td>
    <td class="detail">${escapeHtml(item.detail ?? '')}${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}</td>
  </tr>`;
}

function renderPage({ settings, channels, flash, csrfToken, relay, store, gmail, slack, config }) {
  const problems = relay.setupProblems(settings);
  const summary = statusSummary(settings, problems);
  const review = store.countDeliveries('needs_review');
  const activity = store.recentActivity(50);

  const toggle = settings.enabled
    ? postButton({ action: '/toggle', label: 'ON ●', csrfToken, fields: { enabled: 'off' }, className: 'switch on' })
    : postButton({ action: '/toggle', label: 'OFF ○', csrfToken, fields: { enabled: 'on' }, className: 'switch off', disabled: problems.length > 0 });

  const gmailRow = settings.gmail_email
    ? `${escapeHtml(settings.gmail_email)}
       ${settings.gmail_state === 'reauth' ? '<a class="button small" href="/connect/google">Reconnect Gmail</a>' : ''}
       ${postButton({ action: '/disconnect/google', label: 'Disconnect', csrfToken, className: 'small secondary' })}`
    : gmail.isConfigured()
      ? '<a class="button small" href="/connect/google">Connect Gmail</a>'
      : '<span class="muted">Not connected. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart.</span>';

  const tokenForm = `<details${slack.isOAuthConfigured() ? '' : ' open'}>
      <summary>${slack.isOAuthConfigured() ? 'Or paste a Slack user token' : 'Paste a Slack user token'}</summary>
      <form method="post" action="/connect/slack/token" class="token-form">${hiddenCsrf(csrfToken)}
        <input type="password" name="token" placeholder="xoxp-…" autocomplete="off" required>
        <button type="submit" class="small">Connect</button>
      </form>
      <p class="hint">Needs user scopes ${SLACK_USER_SCOPES.map((s) => `<code>${s}</code>`).join(', ')}. See the README.</p>
    </details>`;

  const slackAccountRow = settings.slack_user_id
    ? `@${escapeHtml(settings.slack_user_name)} <span class="muted">(your Slack account)</span>
       ${settings.slack_state === 'reauth' ? (slack.isOAuthConfigured() ? '<a class="button small" href="/connect/slack">Reconnect Slack</a>' : tokenForm) : ''}
       ${postButton({ action: '/disconnect/slack', label: 'Disconnect', csrfToken, className: 'small secondary' })}`
    : `${slack.isOAuthConfigured() ? '<a class="button small" href="/connect/slack">Connect Slack</a>' : ''}${tokenForm}`;

  let channelControl = '<span class="muted">Connect Slack first.</span>';
  if (settings.slack_user_id) {
    const options = channels.channels.slice();
    if (settings.slack_channel_id && !options.some((c) => c.id === settings.slack_channel_id)) {
      options.unshift({ id: settings.slack_channel_id, name: `${settings.slack_channel_name ?? settings.slack_channel_id} (not a member?)` });
    }
    channelControl = `<select name="channel_id" form="settings-form" required>
        <option value="">Choose a channel…</option>
        ${options.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === settings.slack_channel_id ? ' selected' : ''}>${c.isPrivate ? '🔒' : '#'}${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <a class="small-link" href="/?refresh">Refresh list</a>
      ${channels.error ? `<p class="error-text">Could not load channels: ${escapeHtml(channels.error)}</p>` : ''}
      <p class="hint">Only channels you are a member of are listed.</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ListRelay${settings.enabled ? ' — On' : ' — Off'}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <main>
    <header>
      <h1>ListRelay</h1>
      <div class="toggle">
        <span class="toggle-label">Automation</span>
        ${toggle}
      </div>
    </header>

    ${flash ? `<div class="flash ${escapeHtml(flash.kind)}" role="status">${escapeHtml(flash.text)}</div>` : ''}

    <section class="card">
      <dl>
        <dt>Gmail account</dt>
        <dd>${gmailRow}</dd>

        <dt>Filter</dt>
        <dd><code class="filter">${escapeHtml(settings.gmail_filter)}</code>
          <p class="hint">Only new incoming emails matching this filter are posted. Outgoing and older emails are ignored.</p></dd>

        <dt>Slack workspace</dt>
        <dd>${settings.slack_team_name ? escapeHtml(settings.slack_team_name) : '<span class="muted">Not connected</span>'}</dd>

        <dt>Slack channel</dt>
        <dd>${channelControl}</dd>

        <dt>Post as</dt>
        <dd>${slackAccountRow}</dd>

        <dt>Status</dt>
        <dd><span class="status ${summary.tone}">${escapeHtml(summary.text)}</span>
          ${summary.action === 'gmail' && gmail.isConfigured() ? '<a class="button small" href="/connect/google">Reconnect Gmail</a>' : ''}
          ${summary.action === 'slack' && slack.isOAuthConfigured() ? '<a class="button small" href="/connect/slack">Reconnect Slack</a>' : ''}
          ${review ? `<p class="warn-text">${review} post(s) need review because Slack delivery was uncertain. See activity below.</p>` : ''}</dd>

        <dt>Last successful check</dt>
        <dd>${escapeHtml(formatTime(settings.last_success_at))}</dd>
      </dl>

      <form id="settings-form" method="post" action="/settings" class="buttons">
        ${hiddenCsrf(csrfToken)}
        <button type="submit"${settings.slack_user_id ? '' : ' disabled'}>Save Settings</button>
        <button type="submit" formaction="/test" class="secondary"${settings.slack_channel_id ? '' : ' disabled'}>Send Test Message</button>
      </form>
      <p class="hint">The test posts a message labeled “[ListRelay test]” to the saved channel.</p>
    </section>

    <section>
      <h2>Recent activity <a class="small-link" href="/">Refresh</a></h2>
      ${activity.length
        ? `<table class="activity">
            <thead><tr><th>Time</th><th>Type</th><th>Subject</th><th>Status</th><th>Details</th></tr></thead>
            <tbody>${activity.map((item) => renderActivityRow(item, settings, csrfToken)).join('')}</tbody>
          </table>`
        : '<p class="muted">No activity yet.</p>'}
    </section>
    <footer class="muted">Checks Gmail about every ${Math.round(config.pollIntervalMs / 1000)} seconds while automation is on.</footer>
  </main>
</body>
</html>`;
}

const STYLES = `
:root { --fg: #1d1d1f; --muted: #6e6e73; --line: #e3e3e8; --bg: #f6f6f8; --card: #fff;
  --accent: #4a154b; --ok: #1a7f37; --warn: #9a6700; --err: #c62828; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 980px; margin: 0 auto; padding: 24px 20px 48px; }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
h1 { margin: 0; font-size: 26px; }
h2 { font-size: 18px; margin: 28px 0 10px; }
.toggle { display: flex; align-items: center; gap: 10px; }
.toggle-label { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px 24px; }
dl { display: grid; grid-template-columns: 170px 1fr; gap: 14px 16px; margin: 0 0 18px; }
dt { color: var(--muted); padding-top: 3px; }
dd { margin: 0; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0f0f3; padding: 2px 6px; border-radius: 5px; }
.filter { font-size: 14px; }
.hint { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
.muted { color: var(--muted); }
.inline { display: inline; margin-left: 6px; }
button, .button { font: inherit; border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 7px 14px;
  border-radius: 8px; cursor: pointer; text-decoration: none; display: inline-block; }
button.secondary, .button.secondary { background: #fff; color: var(--accent); }
button.small, .button.small { padding: 3px 10px; font-size: 13px; }
button:disabled { opacity: .45; cursor: not-allowed; }
.switch { min-width: 92px; font-weight: 600; border-radius: 999px; }
.switch.on { background: var(--ok); border-color: var(--ok); }
.switch.off { background: #fff; color: var(--muted); border-color: #c7c7cc; }
.buttons { display: flex; gap: 10px; }
.small-link { font-size: 13px; margin-left: 8px; font-weight: normal; }
select { font: inherit; padding: 5px 8px; border-radius: 8px; border: 1px solid #c7c7cc; min-width: 240px; }
.token-form { display: flex; gap: 8px; margin-top: 8px; }
.token-form input { flex: 1; max-width: 360px; font: inherit; padding: 5px 8px; border-radius: 8px; border: 1px solid #c7c7cc; }
details { margin-top: 6px; }
summary { cursor: pointer; color: var(--accent); font-size: 14px; }
.status { font-weight: 600; }
.status.ok { color: var(--ok); } .status.warn { color: var(--warn); } .status.error { color: var(--err); } .status.muted { color: var(--muted); }
.error-text { color: var(--err); font-size: 13px; margin: 4px 0 0; }
.warn-text { color: var(--warn); font-size: 13px; margin: 6px 0 0; }
.flash { padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; border: 1px solid; }
.flash.success { background: #eaf6ec; border-color: #b7dfbf; color: #14532d; }
.flash.error { background: #fdecec; border-color: #f3b9b9; color: #7f1d1d; }
table.activity { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; font-size: 14px; }
.activity th, .activity td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.activity th { background: #fafafa; color: var(--muted); font-weight: 500; }
.activity .time { white-space: nowrap; color: var(--muted); }
.activity .subject { max-width: 340px; overflow-wrap: anywhere; }
.activity .detail { color: var(--muted); max-width: 260px; overflow-wrap: anywhere; }
.activity tr.event.error td, .activity tr.event.warn td { color: var(--err); }
.actions { margin-top: 4px; } .actions .inline:first-child { margin-left: 0; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: #eee; white-space: nowrap; }
.badge.posted { background: #e3f4e6; color: var(--ok); }
.badge.skipped, .badge.dismissed, .badge.canceled { background: #f0f0f3; color: var(--muted); }
.badge.queued, .badge.sending { background: #fff4d6; color: var(--warn); }
.badge.failed, .badge.needs_review { background: #fdecec; color: var(--err); }
footer { margin-top: 24px; font-size: 13px; }
`;
