import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * Fixed-window counter per key, in process memory. Enough for one API process; when the API is
 * scaled out, back this with Redis (keys `t:{tenant}:` do not apply here: auth is pre-tenant).
 */
@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  /** Throws 429 when `key` has been hit more than `max` times in `windowMs`. */
  hit(key: string, max: number, windowMs: number): void {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      this.prune(now);
      return;
    }
    entry.count += 1;
    if (entry.count > max) {
      throw new HttpException(
        { message: 'Too many attempts. Try again later.', retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Test hook: forget all counters. */
  reset(): void {
    this.hits.clear();
  }

  private prune(now: number): void {
    if (this.hits.size < 10_000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
