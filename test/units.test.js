import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import {
  buildGmailQuery,
  GMAIL_FILTER,
  isOutgoing,
  normalizeSubject,
  parseEmailAddress,
  subjectMatchesAnn,
  toSlackText,
} from '../src/filter.js';
import { Sealer } from '../src/secrets.js';
import { classifySlackFailure, SlackClient } from '../src/slack.js';
import { makeStore } from './helpers.js';

test('the Gmail filter is exactly the specified search', () => {
  assert.equal(GMAIL_FILTER, 'to:cs3157@lists.cs.columbia.edu -subject:ANN');
  assert.equal(buildGmailQuery(GMAIL_FILTER, 1_700_000_000_999), `${GMAIL_FILTER} after:1700000000`);
});

test('ANN matching follows Gmail word matching', () => {
  for (const subject of ['[ANN] HW1', 'ANN: exam', 'Re: [ann] lab', 'ANN', 'Midterm (ANN)']) {
    assert.equal(subjectMatchesAnn(subject), true, subject);
  }
  for (const subject of ['Annual', 'Planning', 'BANNER', 'Question', '', null]) {
    assert.equal(subjectMatchesAnn(subject), false, String(subject));
  }
});

test('subjects are decoded, cleaned, and defaulted', () => {
  assert.equal(normalizeSubject('=?UTF-8?B?UmU6IGjDqWxsbw==?='), 'Re: héllo');
  assert.equal(normalizeSubject('=?ISO-8859-1?Q?caf=E9_time?='), 'café time');
  assert.equal(normalizeSubject('Re: a\r\n  folded   subject'), 'Re: a folded subject');
  assert.equal(normalizeSubject('   '), '(No subject)');
  assert.equal(normalizeSubject(null), '(No subject)');
});

test('Slack text escaping neutralizes mentions and links', () => {
  assert.equal(toSlackText('<!here> <@U1> <http://x|y> & more'), '&lt;!here&gt; &lt;@U1&gt; &lt;http://x|y&gt; &amp; more');
});

test('outgoing detection uses the SENT label and the sender address', () => {
  assert.equal(parseEmailAddress('Me Person <ME@Columbia.edu>'), 'me@columbia.edu');
  assert.equal(isOutgoing({ labelIds: ['SENT'], from: 'x@y.z' }, 'me@columbia.edu'), true);
  assert.equal(isOutgoing({ labelIds: ['INBOX'], from: '"Me" <me@columbia.edu>' }, 'me@columbia.edu'), true);
  assert.equal(isOutgoing({ labelIds: ['INBOX'], from: 'Prof <prof@columbia.edu>' }, 'me@columbia.edu'), false);
});

test('Slack failures are classified for the right recovery', () => {
  assert.equal(classifySlackFailure({ status: 429, retryAfterMs: 1000 }).kind, 'retry');
  assert.equal(classifySlackFailure({ status: 200, error: 'ratelimited' }).kind, 'retry');
  assert.equal(classifySlackFailure({ status: 200, error: 'token_revoked' }).kind, 'auth');
  assert.equal(classifySlackFailure({ status: 200, error: 'missing_scope' }).kind, 'auth');
  assert.equal(classifySlackFailure({ status: 200, error: 'not_in_channel' }).kind, 'channel');
  assert.equal(classifySlackFailure({ status: 200, error: 'restricted_action_foo' }).kind, 'channel');
  assert.equal(classifySlackFailure({ status: 200, error: 'internal_error' }).kind, 'uncertain');
  assert.equal(classifySlackFailure({ status: 504 }).kind, 'uncertain');
  assert.equal(classifySlackFailure({ status: 503 }).kind, 'retry');
  assert.equal(classifySlackFailure({ status: 200, error: 'msg_too_long' }).kind, 'fatal');
});

test('Slack timeouts are reported as uncertain, unreachable hosts as retryable', async () => {
  const store = makeStore();
  store.setCredential('slack', { access_token: 'xoxp-test', expires_at: null });
  const timeout = new SlackClient({
    store,
    fetchImpl: async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    },
  });
  await assert.rejects(timeout.postMessage('C1', 'hi'), { kind: 'uncertain' });

  const refused = new SlackClient({
    store,
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
  });
  await assert.rejects(refused.postMessage('C1', 'hi'), { kind: 'retry' });
});

test('Slack posts are sent with the user token and formatting disabled', async () => {
  const store = makeStore();
  store.setCredential('slack', { access_token: 'xoxp-secret', expires_at: null });
  let captured;
  const client = new SlackClient({
    store,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ ok: true, ts: '1.2', channel: 'C1', message: { user: 'U1' } }));
    },
  });
  const result = await client.postMessage('C1', 'Re: hi');
  assert.deepEqual(result, { ts: '1.2', channel: 'C1', user: 'U1' });
  assert.equal(captured.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(captured.init.headers.Authorization, 'Bearer xoxp-secret');
  const body = new URLSearchParams(captured.init.body.toString());
  assert.equal(body.get('mrkdwn'), 'false');
  assert.equal(body.get('link_names'), 'false');
  assert.equal(body.get('parse'), 'none');
});

test('credentials are encrypted at rest', () => {
  const sealer = new Sealer(crypto.randomBytes(32));
  const sealed = sealer.seal({ access_token: 'xoxp-very-secret' });
  assert.doesNotMatch(sealed, /very-secret/);
  assert.deepEqual(sealer.open(sealed), { access_token: 'xoxp-very-secret' });
  assert.throws(() => new Sealer(crypto.randomBytes(32)).open(sealed));
});
