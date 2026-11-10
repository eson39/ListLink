import { DatabaseSync } from 'node:sqlite';
import { GMAIL_FILTER } from './filter.js';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    provider TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    gmail_message_id TEXT UNIQUE,
    received_at INTEGER,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    slack_channel TEXT,
    slack_ts TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS deliveries_updated ON deliveries (updated_at);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_at ON events (at);
`;

export const DEFAULT_SETTINGS = Object.freeze({
  gmail_filter: GMAIL_FILTER,
  gmail_email: null,
  gmail_state: 'ok', // ok | error | reauth
  gmail_error: null,
  gmail_failures: 0,
  gmail_retry_at: null,
  slack_team_id: null,
  slack_team_name: null,
  slack_team_url: null,
  slack_user_id: null,
  slack_user_name: null,
  slack_channel_id: null,
  slack_channel_name: null,
  slack_state: 'ok', // ok | blocked | reauth
  slack_error: null,
  enabled: false,
  activated_at: null,
  checkpoint: null,
  last_success_at: null,
  last_post_at: null,
  last_pruned_at: null,
});

const DELIVERY_COLUMNS = new Set([
  'status',
  'detail',
  'slack_channel',
  'slack_ts',
  'retry_count',
  'next_attempt_at',
]);

export class Store {
  #db;
  #sealer;

  constructor(filename, sealer) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(SCHEMA);
    this.#sealer = sealer;
  }

  close() {
    this.#db.close();
  }

  transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  getSettings() {
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of this.#db.prepare('SELECT key, value FROM settings').all()) {
      if (row.key in DEFAULT_SETTINGS) settings[row.key] = JSON.parse(row.value);
    }
    return settings;
  }

  updateSettings(patch) {
    const upsert = this.#db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
        upsert.run(key, JSON.stringify(value ?? null));
      }
    });
  }

  getCredential(provider) {
    const row = this.#db.prepare('SELECT sealed FROM credentials WHERE provider = ?').get(provider);
    return row ? this.#sealer.open(row.sealed) : null;
  }

  setCredential(provider, value) {
    this.#db
      .prepare(
        `INSERT INTO credentials (provider, sealed, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
      )
      .run(provider, this.#sealer.seal(value), Date.now());
  }

  deleteCredential(provider) {
    this.#db.prepare('DELETE FROM credentials WHERE provider = ?').run(provider);
  }

  hasDelivery(gmailMessageId) {
    return Boolean(this.#db.prepare('SELECT 1 FROM deliveries WHERE gmail_message_id = ?').get(gmailMessageId));
  }

  /** Inserts a delivery record; returns its id, or null if this Gmail message was already recorded. */
  insertDelivery({ kind = 'email', gmailMessageId = null, receivedAt = null, subject, status, detail = null, nextAttemptAt = null, now }) {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO deliveries
           (kind, gmail_message_id, received_at, subject, status, detail, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, gmailMessageId, receivedAt, subject, status, detail, nextAttemptAt, now, now);
    return result.changes ? Number(result.lastInsertRowid) : null;
  }

  getDelivery(id) {
    return this.#db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) ?? null;
  }

  updateDelivery(id, patch, now) {
    const keys = Object.keys(patch);
    for (const key of keys) if (!DELIVERY_COLUMNS.has(key)) throw new Error(`Unknown delivery column: ${key}`);
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    this.#db
      .prepare(`UPDATE deliveries SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => patch[key] ?? null), now, id);
  }

  nextDueDelivery(now) {
    return (
      this.#db
        .prepare(
          `SELECT * FROM deliveries
           WHERE status = 'queued' AND next_attempt_at <= ?
           ORDER BY received_at, id LIMIT 1`,
        )
        .get(now) ?? null
    );
  }

  countDeliveries(status) {
    return this.#db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE status = ?').get(status).n;
  }

  cancelQueued(detail, now) {
    return this.#db
      .prepare(`UPDATE deliveries SET status = 'canceled', detail = ?, next_attempt_at = NULL, updated_at = ? WHERE status = 'queued'`)
      .run(detail, now).changes;
  }

  /** Posts interrupted mid-request may or may not have reached Slack, so they need review. */
  markInterruptedForReview(detail, now) {
    return this.#db
      .prepare(`UPDATE deliveries SET status = 'needs_review', detail = ?, updated_at = ? WHERE status = 'sending'`)
      .run(detail, now).changes;
  }

  addEvent(level, message, now) {
    this.#db.prepare('INSERT INTO events (at, level, message) VALUES (?, ?, ?)').run(now, level, message);
  }

  recentActivity(limit = 50) {
    const deliveries = this.#db
      .prepare('SELECT *, updated_at AS at FROM deliveries ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ type: 'delivery', ...row }));
    const events = this.#db
      .prepare('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ type: 'event', ...row }));
    return [...deliveries, ...events].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /** Drops old history, keeping any record that could still fall inside the Gmail query window. */
  prune({ before, keepReceivedAfter }) {
    this.#db
      .prepare(
        `DELETE FROM deliveries
         WHERE updated_at < ? AND status NOT IN ('queued', 'sending', 'needs_review')
           AND (received_at IS NULL OR received_at < ?)`,
      )
      .run(before, keepReceivedAfter);
    this.#db.prepare('DELETE FROM events WHERE at < ?').run(before);
  }
}
