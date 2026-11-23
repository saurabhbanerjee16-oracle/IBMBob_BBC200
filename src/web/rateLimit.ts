/** Fixed-window in-memory counter. Single-process only (demo-grade); resets on restart. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  private current(key: string, now: number): { count: number; resetAt: number } {
    const entry = this.hits.get(key);
    if (entry && entry.resetAt > now) return entry;
    if (this.hits.size >= this.maxKeys) this.prune(now);
    const fresh = { count: 0, resetAt: now + this.windowMs };
    this.hits.set(key, fresh);
    return fresh;
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    // Still full of live keys: drop the oldest entries rather than grow without bound.
    if (this.hits.size >= this.maxKeys) {
      const drop = this.hits.size - Math.floor(this.maxKeys / 2);
      let i = 0;
      for (const k of this.hits.keys()) {
        if (i++ >= drop) break;
        this.hits.delete(k);
      }
    }
  }

  /** True if the key is already over the limit (does not count a hit). */
  isLimited(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    return !!entry && entry.resetAt > now && entry.count >= this.limit;
  }

  /** Record one hit. Returns true if this hit is allowed (count within limit). */
  hit(key: string, now: number = Date.now()): boolean {
    const entry = this.current(key, now);
    entry.count += 1;
    return entry.count <= this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Seconds until the key's window resets (for Retry-After). */
  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 1;
  }
}
