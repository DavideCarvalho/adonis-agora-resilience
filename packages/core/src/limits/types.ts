import type { KeysQuery } from '../breaker/store.js';

/** How a bulkhead admits calls: at most `limit` at once, each holding a lease for at most `leaseMs`. */
export interface BulkheadConfig {
  limit: number;
  /**
   * How long a slot stays taken if the process holding it dies before releasing it. A call that runs
   * longer than this no longer counts against the limit.
   */
  leaseMs: number;
}

/** The answer to a bulkhead acquire. */
export interface BulkheadAdmission {
  acquired: boolean;
  /** The slot to hand back to `releaseBulkhead`, when acquired. */
  leaseId?: string;
  /** Calls holding a slot right after the decision. */
  active: number;
}

/** A bulkhead's current occupancy. */
export interface BulkheadSnapshot {
  active: number;
}

/**
 * Storage for bulkheads (concurrency limits). The memory store keeps the slots in this process; the
 * Redis and Lucid/SQL stores share them across processes. `acquireBulkhead` MUST be atomic: two
 * callers can never both take the last slot.
 */
export interface BulkheadStore {
  acquireBulkhead(key: string, cfg: BulkheadConfig): Promise<BulkheadAdmission>;
  releaseBulkhead(key: string, leaseId: string): Promise<void>;
  bulkheadSnapshot(key: string): Promise<BulkheadSnapshot>;
  /** Drop every slot of a bulkhead. */
  resetBulkhead(key: string): Promise<void>;
  /** OPTIONAL: list the bulkhead keys this store holds. */
  bulkheadKeys?(opts: KeysQuery): Promise<string[]>;
  /**
   * OPTIONAL: call `listener` when a slot of `key` is released in THIS process, so a queued call can
   * retry at once instead of polling. Returns the unsubscribe function.
   */
  onBulkheadRelease?(key: string, listener: () => void): () => void;
}

/**
 * A token bucket: `limit` tokens refill evenly over every `intervalMs`, and the bucket holds at most
 * `burst` tokens (default `limit`).
 */
export interface RateLimitConfig {
  limit: number;
  intervalMs: number;
  burst?: number;
}

/** The answer to a rate-limit consume. */
export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left after the decision. */
  remaining: number;
  /** When not allowed: how long until enough tokens are back. 0 when allowed. */
  retryAfterMs: number;
}

/** The stored state of a bucket. `tokens` is undefined for a bucket never used (it is full). */
export interface RateLimitSnapshot {
  tokens?: number;
  updatedAt?: number;
  /** The store's clock when the snapshot was taken (to compute the refill since `updatedAt`). */
  now?: number;
}

/**
 * Storage for rate limiters. The memory store counts in this process; the Redis and Lucid/SQL stores
 * share one budget across processes. `consumeRateLimit` MUST be atomic.
 */
export interface RateLimitStore {
  consumeRateLimit(key: string, cfg: RateLimitConfig, cost: number): Promise<RateLimitDecision>;
  rateLimitSnapshot(key: string): Promise<RateLimitSnapshot>;
  /** Refill a bucket completely. */
  resetRateLimit(key: string): Promise<void>;
  /** OPTIONAL: list the rate-limiter keys this store holds. */
  rateLimitKeys?(opts: KeysQuery): Promise<string[]>;
}

/** Whether `store` implements {@link BulkheadStore}. */
export function isBulkheadStore(store: unknown): store is BulkheadStore {
  const s = store as Partial<BulkheadStore> | null;
  return (
    typeof s?.acquireBulkhead === 'function' &&
    typeof s.releaseBulkhead === 'function' &&
    typeof s.bulkheadSnapshot === 'function'
  );
}

/** Whether `store` implements {@link RateLimitStore}. */
export function isRateLimitStore(store: unknown): store is RateLimitStore {
  const s = store as Partial<RateLimitStore> | null;
  return typeof s?.consumeRateLimit === 'function' && typeof s.rateLimitSnapshot === 'function';
}
