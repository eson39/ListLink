import crypto from 'node:crypto';
import { LIST_ADDRESS } from '../src/filter.js';
import { Relay } from '../src/relay.js';
import { Sealer } from '../src/secrets.js';
import { SlackError } from '../src/slack.js';
import { Store } from '../src/store.js';

export const ME = 'me@columbia.edu';
export const SLACK_USER = 'U_ME';
export const CHANNEL = 'C_LIST';

export class FakeClock {
  constructor(start = Date.UTC(2026, 10, 10, 12, 0, 0)) {
    this.now = start;
  }
  advance(ms) {
    this.now += ms;
  }
  fn = () => this.now;
}

/** Simulates Gmail search for `to:<list> -subject:ANN after:<seconds>`. */
export class FakeGmail {
  messages = [];
  failNext = null;
  applySubjectFilter = true;
  #seq = 0;

  receive({ subject, to = LIST_ADDRESS, from = 'student@columbia.edu', labelIds = ['INBOX'], at }) {
    const id = `m${++this.#seq}`;
    this.messages.push({ id, threadId: `t${id}`, subject, to, from, labelIds, internalDate: at });
    return id;
  }

  async getProfile() {
    return { emailAddress: ME };
  }

  async listMessageIds(query) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const after = Number(/after:(\d+)/.exec(query)[1]) * 1000;
    return this.messages
      .filter((m) => m.to.includes(LIST_ADDRESS))
      .filter((m) => !this.applySubjectFilter || !/\bann\b/i.test(m.subject ?? ''))
      .filter((m) => m.internalDate >= after)
      .map((m) => m.id);
  }

  async getMessageMeta(id) {
    const m = this.messages.find((x) => x.id === id);
    return m ? { ...m } : null;
  }
}

export class FakeSlack {
  posts = [];
  failures = [];
  userId = SLACK_USER;
  memberChannels = [{ id: CHANNEL, name: 'listserv-updates', isPrivate: false }];

  failWith(kind, code, opts) {
    this.failures.push(new SlackError(kind, code, `${code} happened`, opts));
  }

  async inspectToken() {
    return { userId: this.userId, userName: 'me', teamId: 'T1', teamName: 'CS3157', isBot: false, scopes: ['chat:write', 'channels:read', 'groups:read'] };
  }

  async listMemberChannels() {
    return this.memberChannels;
  }

  async postMessage(channel, text) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const ts = `${1700000000 + this.posts.length}.000100`;
    this.posts.push({ channel, text, ts, user: this.userId });
    return { ts, channel, user: this.userId };
  }
}

export function makeStore(filename = ':memory:') {
  return new Store(filename, new Sealer(crypto.randomBytes(32)));
}

export function connectAccounts(store) {
  store.updateSettings({
    gmail_email: ME,
    slack_team_id: 'T1',
    slack_team_name: 'CS3157',
    slack_user_id: SLACK_USER,
    slack_user_name: 'me',
    slack_channel_id: CHANNEL,
    slack_channel_name: 'listserv-updates',
  });
}

export function setup({ connected = true } = {}) {
  const clock = new FakeClock();
  const store = makeStore();
  const gmail = new FakeGmail();
  const slack = new FakeSlack();
  if (connected) connectAccounts(store);
  const relay = new Relay({ store, gmail, slack, clock: clock.fn, pollIntervalMs: 60_000 });
  return { clock, store, gmail, slack, relay };
}
