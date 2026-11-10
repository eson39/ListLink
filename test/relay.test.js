import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TEST_MESSAGE_TEXT } from '../src/filter.js';
import { GmailError } from '../src/gmail.js';
import { MAX_RETRIES, Relay } from '../src/relay.js';
import { Sealer } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { CHANNEL, connectAccounts, FakeClock, FakeGmail, FakeSlack, ME, setup, SLACK_USER } from './helpers.js';
import crypto from 'node:crypto';

const MINUTE = 60_000;

async function enabled(ctx) {
  const result = await ctx.relay.enable();
  assert.equal(result.ok, true, result.error);
  ctx.clock.advance(1000);
  return ctx;
}

function statuses(store) {
  return store
    .recentActivity(100)
    .filter((item) => item.type === 'delivery')
    .map((item) => [item.subject, item.status]);
}

test('automation starts off and cannot be enabled until setup is complete', async () => {
  const ctx = setup({ connected: false });
  assert.equal(ctx.store.getSettings().enabled, false);
  const result = await ctx.relay.enable();
  assert.equal(result.ok, false);
  assert.match(result.error, /Connect Gmail/);
  assert.equal(ctx.store.getSettings().enabled, false);
});

test('1. a new matching email produces exactly one Slack post as the user', async () => {
  const ctx = await enabled(setup());
  ctx.gmail.receive({ subject: 'Re: Question about the assignment', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.deepEqual(ctx.slack.posts.map((p) => [p.channel, p.text, p.user]), [
    [CHANNEL, 'Re: Question about the assignment', SLACK_USER],
  ]);
});

test('2. subjects matching ANN produce no posts, even if Gmail returns them', async () => {
  const ctx = await enabled(setup());
  ctx.gmail.applySubjectFilter = false;
  ctx.gmail.receive({ subject: '[ANN] Midterm logistics', at: ctx.clock.now });
  ctx.gmail.receive({ subject: 'ann: lab 3 posted', at: ctx.clock.now });
  ctx.gmail.receive({ subject: 'Annual survey', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), ['Annual survey']);
  assert.ok(statuses(ctx.store).some(([s, st]) => s === '[ANN] Midterm logistics' && st === 'skipped'));
});

test('3. emails outside the filter produce no posts', async () => {
  const ctx = await enabled(setup());
  ctx.gmail.receive({ subject: 'Unrelated', to: 'someone@columbia.edu', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);
});

test('4. outgoing and historical emails produce no posts', async () => {
  const ctx = setup();
  ctx.gmail.receive({ subject: 'Old question', at: ctx.clock.now - 10 * MINUTE });
  await enabled(ctx);
  ctx.gmail.receive({ subject: 'My own question', from: `Me <${ME}>`, labelIds: ['INBOX'], at: ctx.clock.now });
  ctx.gmail.receive({ subject: 'Sent copy', labelIds: ['SENT'], at: ctx.clock.now });
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);
});

test('5. rechecking does not create duplicates, including replies in the same thread', async () => {
  const ctx = await enabled(setup());
  ctx.gmail.receive({ subject: 'Re: HW2', at: ctx.clock.now });
  await ctx.relay.tick();
  ctx.clock.advance(MINUTE);
  await ctx.relay.tick();
  ctx.clock.advance(MINUTE);
  ctx.gmail.receive({ subject: 'Re: HW2', at: ctx.clock.now });
  await Promise.all([ctx.relay.tick(), ctx.relay.tick()]);
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), ['Re: HW2', 'Re: HW2']);
});

test('6. subjects are posted as plain text without triggering mentions', async () => {
  const ctx = await enabled(setup());
  ctx.gmail.receive({ subject: '<!channel> help & <@U123>', at: ctx.clock.now });
  ctx.gmail.receive({ subject: '', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), ['&lt;!channel&gt; help &amp; &lt;@U123&gt;', '(No subject)']);
});

test('6. enabling refuses when Slack is not authorized as the user', async () => {
  const ctx = setup();
  ctx.slack.userId = 'U_SOMEONE_ELSE';
  const result = await ctx.relay.enable();
  assert.equal(result.ok, false);
  assert.equal(ctx.store.getSettings().enabled, false);
});

test('7. turning off prevents new posts and cancels pending retries', async () => {
  const ctx = await enabled(setup());
  ctx.slack.failWith('retry', 'ratelimited', { retryAfterMs: 30_000 });
  ctx.gmail.receive({ subject: 'Rate limited', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);

  ctx.relay.disable();
  ctx.gmail.receive({ subject: 'While off', at: ctx.clock.now });
  ctx.clock.advance(10 * MINUTE);
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);
  assert.ok(statuses(ctx.store).some(([s, st]) => s === 'Rate limited' && st === 'canceled'));
});

test('8. turning back on posts new arrivals but not emails received while paused', async () => {
  const ctx = await enabled(setup());
  ctx.relay.disable();
  ctx.clock.advance(5 * MINUTE);
  ctx.gmail.receive({ subject: 'Received while paused', at: ctx.clock.now });
  ctx.clock.advance(5 * MINUTE);
  await enabled(ctx);
  ctx.gmail.receive({ subject: 'Received after resuming', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), ['Received after resuming']);
});

test('9. switch state and processed emails persist across restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listrelay-'));
  const file = path.join(dir, 'test.db');
  const sealer = new Sealer(crypto.randomBytes(32));
  const clock = new FakeClock();
  const gmail = new FakeGmail();
  const slack = new FakeSlack();

  let store = new Store(file, sealer);
  connectAccounts(store);
  let relay = new Relay({ store, gmail, slack, clock: clock.fn });
  assert.equal((await relay.enable()).ok, true);
  clock.advance(1000);
  gmail.receive({ subject: 'Before restart', at: clock.now });
  await relay.tick();
  store.close();

  store = new Store(file, sealer);
  relay = new Relay({ store, gmail, slack, clock: clock.fn });
  relay.recover();
  assert.equal(store.getSettings().enabled, true);
  clock.advance(MINUTE);
  gmail.receive({ subject: 'After restart', at: clock.now });
  await relay.tick();
  assert.deepEqual(slack.posts.map((p) => p.text), ['Before restart', 'After restart']);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('10. Slack authorization errors pause delivery and are visible; reconnecting resumes', async () => {
  const ctx = await enabled(setup());
  ctx.slack.failWith('auth', 'token_revoked');
  ctx.gmail.receive({ subject: 'Needs reconnect', at: ctx.clock.now });
  await ctx.relay.tick();
  const settings = ctx.store.getSettings();
  assert.equal(settings.slack_state, 'reauth');
  assert.ok(ctx.store.recentActivity().some((item) => item.type === 'event' && /Slack delivery paused/.test(item.message)));

  ctx.clock.advance(MINUTE);
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);

  ctx.store.updateSettings({ slack_state: 'ok', slack_error: null });
  await ctx.relay.tick();
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), ['Needs reconnect']);
});

test('10. Gmail authorization errors pause processing and are visible', async () => {
  const ctx = await enabled(setup());
  ctx.gmail.failNext = new GmailError('auth', 'Gmail authorization expired or was revoked. Reconnect Gmail.');
  await ctx.relay.tick();
  assert.equal(ctx.store.getSettings().gmail_state, 'reauth');
  ctx.gmail.receive({ subject: 'Waiting for Gmail', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);
});

test('temporary Gmail failures back off and then recover', async () => {
  const ctx = await enabled(setup());
  ctx.gmail.failNext = new GmailError('retry', 'Gmail request failed (HTTP 503).');
  ctx.gmail.receive({ subject: 'Delayed', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.equal(ctx.store.getSettings().gmail_state, 'error');
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0, 'waits for the backoff before checking again');
  ctx.clock.advance(2 * MINUTE);
  await ctx.relay.tick();
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), ['Delayed']);
  assert.equal(ctx.store.getSettings().gmail_state, 'ok');
});

test('rate limits are retried after the requested delay', async () => {
  const ctx = await enabled(setup());
  ctx.slack.failWith('retry', 'ratelimited', { retryAfterMs: 5 * MINUTE });
  ctx.gmail.receive({ subject: 'Eventually', at: ctx.clock.now });
  await ctx.relay.tick();
  ctx.clock.advance(2 * MINUTE);
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);
  ctx.clock.advance(4 * MINUTE);
  await ctx.relay.tick();
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), ['Eventually']);
});

test('persistent temporary failures give up after the retry limit', async () => {
  const ctx = await enabled(setup());
  for (let i = 0; i <= MAX_RETRIES; i++) ctx.slack.failWith('retry', 'service_unavailable');
  ctx.gmail.receive({ subject: 'Never makes it', at: ctx.clock.now });
  for (let i = 0; i <= MAX_RETRIES + 1; i++) {
    await ctx.relay.tick();
    ctx.clock.advance(31 * MINUTE);
  }
  assert.equal(ctx.slack.posts.length, 0);
  assert.ok(statuses(ctx.store).some(([s, st]) => s === 'Never makes it' && st === 'failed'));
});

test('uncertain Slack delivery is marked for review instead of reposted', async () => {
  const ctx = await enabled(setup());
  ctx.slack.failWith('uncertain', 'timeout');
  ctx.gmail.receive({ subject: 'Maybe posted', at: ctx.clock.now });
  await ctx.relay.tick();
  ctx.clock.advance(10 * MINUTE);
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);
  const row = ctx.store.recentActivity().find((item) => item.subject === 'Maybe posted');
  assert.equal(row.status, 'needs_review');

  assert.equal((await ctx.relay.retryDelivery(row.id)).ok, true);
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), ['Maybe posted']);
  assert.equal((await ctx.relay.retryDelivery(row.id)).ok, false, 'cannot be posted twice');
});

test('posts interrupted by a restart are flagged for review', async () => {
  const ctx = await enabled(setup());
  const id = ctx.store.insertDelivery({ gmailMessageId: 'mx', receivedAt: ctx.clock.now, subject: 'Interrupted', status: 'sending', now: ctx.clock.now });
  ctx.relay.recover();
  await ctx.relay.tick();
  assert.equal(ctx.store.getDelivery(id).status, 'needs_review');
  assert.equal(ctx.slack.posts.length, 0);
});

test('11. test messages are labeled and only sent on request', async () => {
  const ctx = setup();
  await ctx.relay.tick();
  assert.equal(ctx.slack.posts.length, 0);
  const result = await ctx.relay.sendTest();
  assert.equal(result.ok, true);
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), [TEST_MESSAGE_TEXT]);
  assert.match(TEST_MESSAGE_TEXT, /^\[ListRelay test\]/);
});

test('a successful test clears a channel problem', async () => {
  const ctx = await enabled(setup());
  ctx.slack.failWith('channel', 'not_in_channel');
  ctx.gmail.receive({ subject: 'Blocked', at: ctx.clock.now });
  await ctx.relay.tick();
  assert.equal(ctx.store.getSettings().slack_state, 'blocked');
  assert.equal((await ctx.relay.sendTest()).ok, true);
  assert.equal(ctx.store.getSettings().slack_state, 'ok');
  await ctx.relay.tick();
  assert.deepEqual(ctx.slack.posts.map((p) => p.text), [TEST_MESSAGE_TEXT, 'Blocked']);
});
