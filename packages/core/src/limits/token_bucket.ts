import type { RateLimitConfig, RateLimitDecision } from './types.js';

/**
 * The pure token-bucket math shared by the memory and SQL stores. The Redis store runs the same
 * arithmetic in Lua (`stores/redis_lua.ts`); keep them in step — the shared rate-limit store
 * contract catches drift.
 */

/** Stored bucket state. */
export interface BucketState {
  tokens: number;
  updatedAt: number;
}

/** Bucket capacity: `burst`, else `limit`. */
export function bucketCapacity(cfg: RateLimitConfig): number {
  return cfg.burst ?? cfg.limit;
}

/** Tokens added per millisecond. */
export function refillRate(cfg: RateLimitConfig): number {
  return cfg.limit / cfg.intervalMs;
}

/** How long an untouched bucket takes to fill up from empty (after that it reads as new). */
export function bucketTtlMs(cfg: RateLimitConfig): number {
  return Math.max(1, Math.ceil(bucketCapacity(cfg) / refillRate(cfg)));
}

/** Tokens in the bucket at `now` (a never-used bucket is full). */
export function tokensAt(
  state: BucketState | undefined,
  cfg: RateLimitConfig,
  now: number,
): number {
  const capacity = bucketCapacity(cfg);
  if (!state) return capacity;
  const elapsed = Math.max(0, now - state.updatedAt);
  return Math.min(capacity, state.tokens + elapsed * refillRate(cfg));
}

/** Take `cost` tokens if there are enough; otherwise say how long to wait. */
export function consumeTokens(
  state: BucketState | undefined,
  cfg: RateLimitConfig,
  cost: number,
  now: number,
): { state: BucketState; decision: RateLimitDecision } {
  const available = tokensAt(state, cfg, now);
  if (available >= cost) {
    const tokens = available - cost;
    return {
      state: { tokens, updatedAt: now },
      decision: { allowed: true, remaining: Math.floor(tokens), retryAfterMs: 0 },
    };
  }
  return {
    state: { tokens: available, updatedAt: now },
    decision: {
      allowed: false,
      remaining: Math.floor(available),
      // The epsilon absorbs float noise (0.99 tokens at 0.01/ms is 1ms away, not 1.0000000000000009).
      retryAfterMs: Math.max(1, Math.ceil((cost - available) / refillRate(cfg) - 1e-9)),
    },
  };
}

/** Throw on a config no bucket can satisfy. */
export function assertRateLimitConfig(cfg: RateLimitConfig, cost: number, key: string): void {
  if (!(cfg.limit > 0) || !(cfg.intervalMs > 0)) {
    throw new Error(`rate limiter "${key}": limit and intervalMs must be positive`);
  }
  if (cfg.burst !== undefined && !(cfg.burst > 0)) {
    throw new Error(`rate limiter "${key}": burst must be positive`);
  }
  if (!(cost > 0) || cost > bucketCapacity(cfg)) {
    throw new Error(
      `rate limiter "${key}": cost ${cost} must be positive and at most the bucket size ${bucketCapacity(cfg)}`,
    );
  }
}
