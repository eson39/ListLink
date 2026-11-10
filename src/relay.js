import {
  buildGmailQuery,
  isOutgoing,
  normalizeSubject,
  subjectMatchesAnn,
  TEST_MESSAGE_TEXT,
  toSlackText,
} from './filter.js';
import { GmailError } from './gmail.js';
import { SlackError } from './slack.js';

/** Re-scan this far behind the checkpoint to catch messages Gmail indexes late. */
export const LOOKBACK_MS = 60 * 60 * 1000;
export const MAX_RETRIES = 8;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function retryDelayMs(retryCount) {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, retryCount - 1));
}

export class Relay {
  #store;
  #gmail;
  #slack;
  #clock;
  #pollIntervalMs;
  #timer = null;
  #running = null;

  constructor({ store, gmail, slack, clock = () => Date.now(), pollIntervalMs = 60_000 }) {
    this.#store = store;
    this.#gmail = gmail;
    this.#slack = slack;
    this.#clock = clock;
    this.#pollIntervalMs = pollIntervalMs;
  }

  /** Call once at startup, before the first tick. */
  recover() {
    const count = this.#store.markInterruptedForReview(
      'ListRelay stopped while this post was being sent. Check Slack before retrying.',
      this.#clock(),
    );
    if (count) this.#event('warn', `${count} post(s) were interrupted by a restart and need review.`);
  }

  start() {
    const loop = async () => {
      await this.tick().catch((err) => this.#event('error', `Unexpected error: ${err.message}`));
      this.#timer = setTimeout(loop, this.#pollIntervalMs);
    };
    this.#timer = setTimeout(loop, 1000);
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  kick() {
    setImmediate(() => this.tick().catch((err) => this.#event('error', `Unexpected error: ${err.message}`)));
  }

  /** Runs one check-and-deliver cycle. Concurrent calls share the cycle in progress. */
  tick() {
    this.#running ??= this.#runCycle().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  setupProblems(settings = this.#store.getSettings()) {
    const problems = [];
    if (!settings.gmail_email) problems.push('Connect Gmail.');
    if (!settings.slack_user_id) problems.push('Connect Slack.');
    else if (!settings.slack_channel_id) problems.push('Choose a Slack channel and save settings.');
    return problems;
  }

  /** Verifies both connections live, then turns automation on. Emails received before now are never posted. */
  async enable() {
    const settings = this.#store.getSettings();
    if (settings.enabled) return { ok: true };
    const problems = this.setupProblems(settings);
    if (problems.length) return { ok: false, error: problems.join(' ') };

    try {
      const profile = await this.#gmail.getProfile();
      if (profile.emailAddress?.toLowerCase() !== settings.gmail_email.toLowerCase()) {
        return { ok: false, error: 'The connected Gmail account changed. Reconnect Gmail.' };
      }
    } catch (err) {
      if (err instanceof GmailError && err.kind === 'auth') this.#setGmailReauth(err.message);
      return { ok: false, error: `Gmail check failed: ${err.message}` };
    }

    try {
      const identity = await this.#slack.inspectToken();
      if (identity.isBot || identity.userId !== settings.slack_user_id) {
        return { ok: false, error: 'Slack is not authorized as your user account. Reconnect Slack.' };
      }
      if (identity.scopes.length && !identity.scopes.includes('chat:write')) {
        return { ok: false, error: 'Slack authorization lacks chat:write. Reconnect Slack.' };
      }
      const channels = await this.#slack.listMemberChannels();
      if (!channels.some((channel) => channel.id === settings.slack_channel_id)) {
        return { ok: false, error: `You are not a member of #${settings.slack_channel_name ?? settings.slack_channel_id}. Join it in Slack or choose another channel.` };
      }
    } catch (err) {
      if (err instanceof SlackError && err.kind === 'auth') this.#setSlackState('reauth', err.message);
      return { ok: false, error: `Slack check failed: ${err.message}` };
    }

    const now = this.#clock();
    this.#store.cancelQueued('Canceled: left over from before automation was turned on.', now);
    this.#store.updateSettings({
      enabled: true,
      activated_at: now,
      checkpoint: now,
      gmail_state: 'ok',
      gmail_error: null,
      gmail_failures: 0,
      gmail_retry_at: null,
      slack_state: 'ok',
      slack_error: null,
    });
    this.#event('info', 'Automation turned on. Only emails received from now on will be posted.');
    return { ok: true };
  }

  disable(reason = 'Automation turned off.') {
    const settings = this.#store.getSettings();
    const now = this.#clock();
    if (settings.enabled) this.#store.updateSettings({ enabled: false });
    const canceled = this.#store.cancelQueued('Canceled because automation was turned off.', now);
    if (settings.enabled) {
      this.#event('info', canceled ? `${reason} ${canceled} pending retry(s) canceled.` : reason);
    }
  }

  async sendTest() {
    const settings = this.#store.getSettings();
    if (!settings.slack_user_id) return { ok: false, error: 'Connect Slack first.' };
    if (!settings.slack_channel_id) return { ok: false, error: 'Choose a Slack channel and save settings first.' };
    const now = this.#clock();
    const id = this.#store.insertDelivery({ kind: 'test', subject: TEST_MESSAGE_TEXT, status: 'queued', now });
    const result = await this.#deliver(this.#store.getDelivery(id), settings, { test: true });
    return result.posted ? { ok: true } : { ok: false, error: result.error };
  }

  /** Explicit user request to resend a failed, canceled, or uncertain email post. */
  async retryDelivery(id) {
    const row = this.#store.getDelivery(id);
    if (!row || row.kind !== 'email' || !['failed', 'canceled', 'needs_review'].includes(row.status)) {
      return { ok: false, error: 'That post cannot be retried.' };
    }
    const settings = this.#store.getSettings();
    if (!settings.slack_user_id || !settings.slack_channel_id) return { ok: false, error: 'Connect Slack and choose a channel first.' };
    const result = await this.#deliver(row, settings, { manual: true });
    return result.posted ? { ok: true } : { ok: false, error: result.error };
  }

  dismissDelivery(id) {
    const row = this.#store.getDelivery(id);
    if (!row || !['failed', 'canceled', 'needs_review'].includes(row.status)) return { ok: false, error: 'Nothing to dismiss.' };
    this.#store.updateDelivery(id, { status: 'dismissed', detail: 'Dismissed by you; not reposted.', next_attempt_at: null }, this.#clock());
    return { ok: true };
  }

  async #runCycle() {
    const settings = this.#store.getSettings();
    this.#pruneDaily(settings);
    if (!settings.enabled) return;
    const generation = settings.activated_at;
    const slackReady = settings.slack_state === 'ok' && settings.slack_channel_id;
    const gmailDue = settings.gmail_state !== 'reauth' && this.#clock() >= (settings.gmail_retry_at ?? 0);
    if (slackReady && gmailDue) await this.#checkGmail(settings, generation);
    await this.#deliverDue(generation);
  }

  #isCurrent(generation) {
    const settings = this.#store.getSettings();
    return settings.enabled && settings.activated_at === generation;
  }

  async #checkGmail(settings, generation) {
    const startedAt = this.#clock();
    const since = Math.max(settings.activated_at, (settings.checkpoint ?? settings.activated_at) - LOOKBACK_MS);
    let messages;
    try {
      const ids = await this.#gmail.listMessageIds(buildGmailQuery(settings.gmail_filter, since));
      messages = [];
      for (const id of ids) {
        if (this.#store.hasDelivery(id)) continue;
        const message = await this.#gmail.getMessageMeta(id);
        if (message) messages.push(message);
      }
    } catch (err) {
      this.#onGmailError(err);
      return;
    }

    // Everything below is synchronous, so a toggle cannot interleave with recording.
    if (!this.#isCurrent(generation)) return;
    messages.sort((a, b) => a.internalDate - b.internalDate);
    for (const message of messages) this.#admit(message, settings);
    if (settings.gmail_state !== 'ok') this.#event('info', 'Gmail checks are working again.');
    this.#store.updateSettings({
      checkpoint: startedAt,
      last_success_at: this.#clock(),
      gmail_state: 'ok',
      gmail_error: null,
      gmail_failures: 0,
      gmail_retry_at: null,
    });
  }

  #admit(message, settings) {
    const subject = normalizeSubject(message.subject);
    let status = 'queued';
    let detail = null;
    if (message.internalDate < settings.activated_at) {
      status = 'skipped';
      detail = 'Received before automation was turned on.';
    } else if (isOutgoing(message, settings.gmail_email)) {
      status = 'skipped';
      detail = 'Outgoing message sent from your account.';
    } else if (subjectMatchesAnn(subject)) {
      status = 'skipped';
      detail = 'Subject matches ANN.';
    }
    const now = this.#clock();
    this.#store.insertDelivery({
      gmailMessageId: message.id,
      receivedAt: message.internalDate,
      subject,
      status,
      detail,
      nextAttemptAt: status === 'queued' ? now : null,
      now,
    });
  }

  async #deliverDue(generation) {
    for (;;) {
      const settings = this.#store.getSettings();
      if (!settings.enabled || settings.activated_at !== generation) return;
      if (settings.slack_state !== 'ok' || !settings.slack_channel_id) return;
      const row = this.#store.nextDueDelivery(this.#clock());
      if (!row) return;
      const result = await this.#deliver(row, settings, {});
      if (!result.continue) return;
    }
  }

  async #deliver(row, settings, { test = false, manual = false }) {
    const channel = settings.slack_channel_id;
    this.#store.updateDelivery(row.id, { status: 'sending', slack_channel: channel, detail: null }, this.#clock());
    try {
      const text = test ? TEST_MESSAGE_TEXT : toSlackText(row.subject);
      const posted = await this.#slack.postMessage(channel, text);
      const now = this.#clock();
      if (posted.user && posted.user !== settings.slack_user_id) {
        this.#store.updateDelivery(row.id, {
          status: 'posted',
          slack_ts: posted.ts,
          next_attempt_at: null,
          detail: `Slack attributed this post to ${posted.user}, not your account.`,
        }, now);
        this.#setSlackState('blocked', 'Slack posted under an unexpected identity. Reconnect Slack with your user account.');
        return { posted: true, continue: false };
      }
      this.#store.updateDelivery(row.id, {
        status: 'posted',
        slack_ts: posted.ts,
        next_attempt_at: null,
        detail: manual ? 'Posted after a manual retry.' : null,
      }, now);
      const latest = this.#store.getSettings();
      const patch = { last_post_at: now };
      if (latest.slack_state !== 'ok') Object.assign(patch, { slack_state: 'ok', slack_error: null });
      this.#store.updateSettings(patch);
      return { posted: true, continue: true };
    } catch (err) {
      return this.#onDeliveryError(row, err, { test, manual });
    }
  }

  #onDeliveryError(row, err, { test, manual }) {
    const now = this.#clock();
    const kind = err instanceof SlackError ? err.kind : 'uncertain';
    const message = err.message;
    const oneShot = test || manual;
    const update = (patch) => this.#store.updateDelivery(row.id, patch, now);

    if (kind === 'auth' || kind === 'channel') {
      this.#setSlackState(kind === 'auth' ? 'reauth' : 'blocked', message);
      // Automatic posts wait for the problem to be fixed rather than burning retries.
      if (oneShot) update({ status: 'failed', detail: message, next_attempt_at: null });
      else update({ status: 'queued', detail: `Waiting: ${message}`, next_attempt_at: now });
      return { posted: false, continue: false, error: message };
    }
    if (kind === 'retry' && !oneShot) {
      const retryCount = row.retry_count + 1;
      if (retryCount > MAX_RETRIES) {
        update({ status: 'failed', retry_count: retryCount, detail: `Gave up after ${MAX_RETRIES} retries: ${message}`, next_attempt_at: null });
        this.#event('error', `A post failed after ${MAX_RETRIES} retries: ${message}`);
      } else {
        const delay = Math.max(err.retryAfterMs ?? 0, retryDelayMs(retryCount));
        update({ status: 'queued', retry_count: retryCount, detail: message, next_attempt_at: now + delay });
      }
      return { posted: false, continue: false, error: message };
    }
    if (kind === 'uncertain') {
      update({ status: 'needs_review', detail: `${message} Check Slack, then retry or dismiss.`, next_attempt_at: null });
      this.#event('warn', 'A Slack post timed out and was not retried automatically, to avoid a duplicate. Review it below.');
      return { posted: false, continue: false, error: message };
    }
    update({ status: 'failed', detail: message, next_attempt_at: null });
    return { posted: false, continue: !oneShot, error: message };
  }

  #onGmailError(err) {
    if (err instanceof GmailError && (err.kind === 'auth' || err.kind === 'config')) {
      this.#setGmailReauth(err.message);
      return;
    }
    const settings = this.#store.getSettings();
    const failures = settings.gmail_failures + 1;
    const delay = Math.max(err.retryAfterMs ?? 0, Math.min(MAX_BACKOFF_MS, this.#pollIntervalMs * 2 ** (failures - 1)));
    if (settings.gmail_error !== err.message) this.#event('warn', `Gmail check failed: ${err.message}`);
    this.#store.updateSettings({
      gmail_state: 'error',
      gmail_error: err.message,
      gmail_failures: failures,
      gmail_retry_at: this.#clock() + delay,
    });
  }

  #setGmailReauth(message) {
    const settings = this.#store.getSettings();
    if (settings.gmail_state !== 'reauth') this.#event('error', `Gmail processing paused: ${message}`);
    this.#store.updateSettings({ gmail_state: 'reauth', gmail_error: message });
  }

  #setSlackState(state, message) {
    const settings = this.#store.getSettings();
    if (settings.slack_state !== state || settings.slack_error !== message) {
      this.#event('error', `Slack delivery paused: ${message}`);
    }
    this.#store.updateSettings({ slack_state: state, slack_error: message });
  }

  #pruneDaily(settings) {
    const now = this.#clock();
    if (settings.last_pruned_at && now - settings.last_pruned_at < DAY_MS) return;
    const windowStart = (settings.checkpoint ?? now) - LOOKBACK_MS - DAY_MS;
    this.#store.prune({ before: now - HISTORY_RETENTION_MS, keepReceivedAfter: windowStart });
    this.#store.updateSettings({ last_pruned_at: now });
  }

  #event(level, message) {
    this.#store.addEvent(level, message, this.#clock());
  }
}
