/**
 * Usage + plan storage behind a tiny async adapter, so Postgres / Redis can replace it later
 * by implementing the same methods:
 *   upsertInstall(iid)                       -> install
 *   getInstall(iid)                          -> install | null
 *   setPlan(iid, plan, meta?)                -> install     meta: { stripeCustomerId, stripeSubscriptionId }
 *   findInstallBySubscription(subscriptionId)-> iid | null
 *   getUsed(iid, day)                        -> number
 *   reserve(iid, day, limit)                 -> { ok, used }   atomic; limit 0 = unlimited
 *   release(iid, day)                        -> void           undo a reservation (failed upstream call)
 *   close()
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const now = () => new Date().toISOString();

export class MemoryStore {
  constructor() { this.installs = new Map(); this.usage = new Map(); }
  async upsertInstall(iid) {
    if (!this.installs.has(iid)) this.installs.set(iid, { iid, plan: 'free', createdAt: now(), stripeCustomerId: null, stripeSubscriptionId: null });
    return { ...this.installs.get(iid) };
  }
  async getInstall(iid) { const i = this.installs.get(iid); return i ? { ...i } : null; }
  async setPlan(iid, plan, meta = {}) {
    const cur = await this.upsertInstall(iid);
    const next = { ...cur, plan, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) };
    this.installs.set(iid, next);
    return { ...next };
  }
  async findInstallBySubscription(sub) {
    for (const i of this.installs.values()) if (sub && i.stripeSubscriptionId === sub) return i.iid;
    return null;
  }
  async getUsed(iid, day) { return this.usage.get(`${iid}|${day}`) || 0; }
  async reserve(iid, day, limit) {
    const k = `${iid}|${day}`;
    const used = this.usage.get(k) || 0;
    if (limit > 0 && used >= limit) return { ok: false, used };
    this.usage.set(k, used + 1);
    return { ok: true, used: used + 1 };
  }
  async release(iid, day) {
    const k = `${iid}|${day}`;
    const used = this.usage.get(k) || 0;
    if (used > 0) this.usage.set(k, used - 1);
  }
  async close() {}
}

export class SqliteStore {
  constructor(file) {
    // Lazy import keeps MemoryStore usable on runtimes without node:sqlite.
    this.file = file;
  }
  async init() {
    const { DatabaseSync } = await import('node:sqlite');
    if (this.file !== ':memory:') mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS installs (
        iid TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL,
        stripe_customer_id TEXT, stripe_subscription_id TEXT);
      CREATE INDEX IF NOT EXISTS installs_sub ON installs(stripe_subscription_id);
      CREATE TABLE IF NOT EXISTS usage (iid TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (iid, day));
    `);
    this.db = db;
    this.q = {
      ins: db.prepare(`INSERT OR IGNORE INTO installs (iid, plan, created_at) VALUES (?, 'free', ?)`),
      get: db.prepare(`SELECT iid, plan, created_at AS createdAt, stripe_customer_id AS stripeCustomerId, stripe_subscription_id AS stripeSubscriptionId FROM installs WHERE iid = ?`),
      plan: db.prepare(`UPDATE installs SET plan = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE iid = ?`),
      bySub: db.prepare(`SELECT iid FROM installs WHERE stripe_subscription_id = ?`),
      used: db.prepare(`SELECT used FROM usage WHERE iid = ? AND day = ?`),
      // Atomic conditional increment: one statement, so concurrent requests cannot overshoot the limit.
      reserve: db.prepare(`INSERT INTO usage (iid, day, used) VALUES (?, ?, 1)
        ON CONFLICT(iid, day) DO UPDATE SET used = used + 1 WHERE ? = 0 OR used < ? RETURNING used`),
      release: db.prepare(`UPDATE usage SET used = used - 1 WHERE iid = ? AND day = ? AND used > 0`),
    };
    return this;
  }
  async upsertInstall(iid) { this.q.ins.run(iid, now()); return { ...this.q.get.get(iid) }; }
  async getInstall(iid) { const r = this.q.get.get(iid); return r ? { ...r } : null; }
  async setPlan(iid, plan, meta = {}) {
    await this.upsertInstall(iid);
    this.q.plan.run(plan, meta.stripeCustomerId ?? null, meta.stripeSubscriptionId ?? null, iid);
    return this.getInstall(iid);
  }
  async findInstallBySubscription(sub) { return (sub && this.q.bySub.get(sub)?.iid) || null; }
  async getUsed(iid, day) { return this.q.used.get(iid, day)?.used || 0; }
  async reserve(iid, day, limit) {
    const r = this.q.reserve.get(iid, day, limit, limit);
    if (r) return { ok: true, used: r.used };
    return { ok: false, used: await this.getUsed(iid, day) };
  }
  async release(iid, day) { this.q.release.run(iid, day); }
  async close() { this.db?.close(); }
}

export async function createStore(config) {
  if (config.store === 'memory') return new MemoryStore();
  return new SqliteStore(config.dataDir === ':memory:' ? ':memory:' : path.join(config.dataDir, 'margin.sqlite')).init();
}
