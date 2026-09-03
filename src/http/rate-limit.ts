/**
 * In-process fixed-window rate limiter for the login endpoint. Single instance
 * only — a multi-process / multi-host deployment must swap this for a shared
 * store (Redis). See docs/DEPLOYMENT.md.
 */

export interface LoginRateLimitConfig {
  maxAttemptsPerIdentity: number;
  maxAttemptsPerIp: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly cfg: LoginRateLimitConfig) {}

  private hit(key: string, max: number, now: number): number | null {
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + this.cfg.windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return null;
  }

  /** Records an attempt. Returns Retry-After seconds if the caller is now blocked. */
  check(ip: string, email: string): number | null {
    const now = Date.now();
    if (this.buckets.size > 20_000) {
      for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    }
    const idBlock = this.hit(`id:${ip}|${email.toLowerCase()}`, this.cfg.maxAttemptsPerIdentity, now);
    const ipBlock = this.hit(`ip:${ip}`, this.cfg.maxAttemptsPerIp, now);
    return idBlock ?? ipBlock;
  }

  /** Clears the counters for a successful login. */
  succeed(ip: string, email: string): void {
    this.buckets.delete(`id:${ip}|${email.toLowerCase()}`);
    this.buckets.delete(`ip:${ip}`);
  }
}
