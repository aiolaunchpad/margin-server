/** In-memory fixed-window limiter (per process). Swap for Redis when running >1 instance. */
export class RateLimiter {
  constructor({ limit, windowMs }) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  /** @returns {{ ok: boolean, retryAfter: number }} */
  take(key, t = Date.now()) {
    if (!this.limit) return { ok: true, retryAfter: 0 };
    let e = this.hits.get(key);
    if (!e || t >= e.reset) { e = { count: 0, reset: t + this.windowMs }; this.hits.set(key, e); }
    e.count++;
    if (this.hits.size > 50000) for (const [k, v] of this.hits) if (t >= v.reset) this.hits.delete(k);
    return e.count <= this.limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.ceil((e.reset - t) / 1000) };
  }
}
