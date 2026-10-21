/**
 * A small in-memory limiter for the sign-in and sign-up routes: at most `max` attempts per key in `windowMs`. It lives in the server's memory, so it
 * is per server process (one process is how Blackline is hosted for now); a restart forgets it. It is there to make guessing passwords slow, not to
 * be a firewall.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Count an attempt under `key`. Says whether it may go ahead and, if not, how many seconds until it could. */
  hit(key: string): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.sweep(t);
    return { ok: true, retryAfterSec: 0 };
  }

  /** Forget a key (a successful sign-in clears that person's count). */
  reset(key: string): void { this.hits.delete(key); }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
  }
}

export const minutes = (sec: number) => (sec <= 90 ? "a minute" : `${Math.ceil(sec / 60)} minutes`);
