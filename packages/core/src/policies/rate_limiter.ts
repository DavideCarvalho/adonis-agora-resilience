import type { ResilienceStore } from '../breaker/store.js';
import { type Clock, systemClock } from '../clock.js';
import { formatMs, tagDescription } from '../describe.js';
import { RateLimitedError } from '../errors.js';
import { currentAmbient, type EventSink, policySink } from '../events.js';
import { assertRateLimitConfig } from '../limits/token_bucket.js';
import { isRateLimitStore, type RateLimitConfig, type RateLimitStore } from '../limits/types.js';
import { type Operation, type Policy, type PolicyContext, rootContext } from '../policy.js';
import { resolvePolicyStore } from '../stores/resolve.js';

export interface RateLimiterOptions {
  /** The limiter's name; calls sharing a key share its budget. */
  key: string;
  /** How many calls are allowed per `intervalMs`. */
  limit: number;
  intervalMs: number;
  /** How many calls may go through at once after a quiet period. Default `limit`. */
  burst?: number;
  /** How many tokens one call takes. Default 1. */
  cost?: number;
  /**
   * Wait up to this long for the budget instead of rejecting. Default 0: reject at once with
   * {@link RateLimitedError}.
   */
  maxWaitMs?: number;
  /**
   * Where the budget lives: a store instance, or the name of a store from `config/resilience.ts`.
   * Omitted: the service's default store in a named policy, else a process-wide in-memory store.
   */
  store?: (ResilienceStore & RateLimitStore) | RateLimitStore | string;
  clock?: Clock;
  onEvent?: EventSink;
}

/**
 * Rate limiter (token bucket): `limit` calls per `intervalMs`, up to `burst` at once. Over budget, a
 * call waits up to `maxWaitMs` or is rejected with {@link RateLimitedError}. With a shared store
 * (Redis, Lucid) the budget is shared by every process.
 */
export function rateLimiter(opts: RateLimiterOptions): Policy {
  const cost = opts.cost ?? 1;
  const cfg: RateLimitConfig = {
    limit: opts.limit,
    intervalMs: opts.intervalMs,
    ...(opts.burst !== undefined ? { burst: opts.burst } : {}),
  };
  assertRateLimitConfig(cfg, cost, opts.key);
  const ambient = currentAmbient();
  const onEvent = policySink(opts.onEvent);
  const store = resolvePolicyStore(
    opts.store as ResilienceStore | string | undefined,
    'rate limiter',
  );
  if (!isRateLimitStore(store)) {
    throw new Error(`rate limiter "${opts.key}": the store does not support rate limiters`);
  }
  const clock = opts.clock ?? systemClock;
  const maxWaitMs = Math.max(0, opts.maxWaitMs ?? 0);
  const observe = ambient.observe;

  const policy: Policy = {
    async execute<T>(op: Operation<T>, parent: PolicyContext = rootContext()): Promise<T> {
      observe?.({ kind: 'rate-limiter', key: opts.key, store, config: { ...cfg } });
      const deadline = clock.now() + maxWaitMs;
      for (;;) {
        const decision = await store.consumeRateLimit(opts.key, cfg, cost);
        if (decision.allowed) break;
        const left = deadline - clock.now();
        if (decision.retryAfterMs > left) {
          onEvent({
            type: 'rate-limited',
            key: opts.key,
            retryAfterMs: decision.retryAfterMs,
            limit: opts.limit,
            intervalMs: opts.intervalMs,
          });
          throw new RateLimitedError(opts.key, decision.retryAfterMs);
        }
        await clock.delay(Math.max(1, decision.retryAfterMs), parent.signal);
      }
      return op({ signal: parent.signal, attempt: parent.attempt });
    },
  };
  const burst =
    opts.burst !== undefined && opts.burst !== opts.limit ? `, burst=${opts.burst}` : '';
  return tagDescription(policy, [
    `rate-limiter(key=${opts.key}, ${opts.limit}/${formatMs(opts.intervalMs)}${burst})`,
  ]);
}
