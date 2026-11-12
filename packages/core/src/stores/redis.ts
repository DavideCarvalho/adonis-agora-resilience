import { randomUUID } from 'node:crypto';
import type { KeysQuery, ResilienceStore } from '../breaker/store.js';
import type { Admission, BreakerConfig, CircuitSnapshot, CircuitStatus } from '../breaker/types.js';
import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import { bucketCapacity, bucketTtlMs, refillRate } from '../limits/token_bucket.js';
import type {
  BulkheadAdmission,
  BulkheadConfig,
  BulkheadSnapshot,
  BulkheadStore,
  RateLimitConfig,
  RateLimitDecision,
  RateLimitSnapshot,
  RateLimitStore,
} from '../limits/types.js';
import {
  ADMIT_LUA,
  BULKHEAD_ACQUIRE_LUA,
  BULKHEAD_COUNT_LUA,
  BULKHEAD_RELEASE_LUA,
  RATE_LIMIT_LUA,
  RECORD_LUA,
} from './redis_lua.js';

/**
 * The slice of an ioredis client this store relies on. Both a raw `ioredis` instance and an
 * `@adonisjs/redis` connection satisfy it (the Adonis connection proxies these methods straight to
 * its underlying ioredis client), so we depend on the surface rather than a concrete type — keeping
 * the peer-dependency coupling minimal and the store testable against `ioredis-mock` or a fake.
 */
export interface RedisLike {
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
  del(key: string): Promise<unknown>;
  /** Optional: `SCAN`, used to list keys. Without it the store cannot enumerate its keys. */
  scan?(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
}

/** {@link RedisLike} augmented with the two Lua commands we register via `defineCommand`. */
interface WithCommands extends RedisLike {
  cbAdmit(key: string, now: number, max: number, ttlMs: number): Promise<[number, number, string]>;
  cbRecord(
    key: string,
    ok: number,
    probe: number,
    now: number,
    threshold: number,
    cooldownMs: number,
    ttlMs: number,
  ): Promise<string>;
  rlBulkheadAcquire(
    key: string,
    now: number,
    limit: number,
    leaseMs: number,
    leaseId: string,
  ): Promise<[number, number]>;
  rlBulkheadRelease(key: string, leaseId: string): Promise<number>;
  rlBulkheadCount(key: string, now: number): Promise<number>;
  rlRateLimit(
    key: string,
    now: number,
    rate: string,
    capacity: number,
    cost: number,
    ttlMs: number,
  ): Promise<[number, string, string]>;
}

const COMMANDS: Record<string, string> = {
  cbAdmit: ADMIT_LUA,
  cbRecord: RECORD_LUA,
  rlBulkheadAcquire: BULKHEAD_ACQUIRE_LUA,
  rlBulkheadRelease: BULKHEAD_RELEASE_LUA,
  rlBulkheadCount: BULKHEAD_COUNT_LUA,
  rlRateLimit: RATE_LIMIT_LUA,
};

export interface RedisResilienceStoreOptions {
  /** Clock used for `now()` / cooldown math. Defaults to the system clock. */
  clock?: Clock;
  /**
   * Key namespace prepended to every circuit key. Defaults to `agora:resilience:circuit:`, so a
   * circuit `payments` is stored at `agora:resilience:circuit:payments`.
   */
  keyPrefix?: string;
  /**
   * Optional sliding TTL (milliseconds) applied to each circuit hash on every write. When set,
   * circuits that stop seeing traffic eventually expire and reset to the closed default. Omit (or
   * pass `0`) to keep circuit state forever.
   */
  ttlMs?: number;
  /** Key namespace for bulkhead slots. Defaults to `agora:resilience:bulkhead:`. */
  bulkheadPrefix?: string;
  /** Key namespace for rate-limiter buckets. Defaults to `agora:resilience:rate-limit:`. */
  rateLimitPrefix?: string;
}

const DEFAULT_PREFIX = 'agora:resilience:circuit:';
const DEFAULT_BULKHEAD_PREFIX = 'agora:resilience:bulkhead:';
const DEFAULT_RATE_LIMIT_PREFIX = 'agora:resilience:rate-limit:';

/**
 * Distributed circuit-breaker {@link ResilienceStore} backed by Redis. Per-circuit state lives in a
 * single Redis hash and is mutated entirely inside server-side Lua scripts, so failure counts and
 * open/half-open transitions are shared across processes and pods with no lost updates and exactly
 * one half-open probe granted under concurrency.
 *
 * The Lua branching mirrors core's pure `computeAdmit` / `computeRecord`, so a Redis-backed circuit
 * behaves identically to the in-memory and SQL stores and passes the same `runResilienceStoreContract`.
 */
export class RedisResilienceStore implements ResilienceStore, BulkheadStore, RateLimitStore {
  private readonly redis: WithCommands;
  private readonly bulkheadPrefix: string;
  private readonly rateLimitPrefix: string;
  private readonly clock: Clock;
  private readonly prefix: string;
  private readonly ttlMs: number;

  constructor(redis: RedisLike, opts: RedisResilienceStoreOptions = {}) {
    this.redis = redis as WithCommands;
    this.clock = opts.clock ?? systemClock;
    this.prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 0;
    this.bulkheadPrefix = opts.bulkheadPrefix ?? DEFAULT_BULKHEAD_PREFIX;
    this.rateLimitPrefix = opts.rateLimitPrefix ?? DEFAULT_RATE_LIMIT_PREFIX;
    // Register the scripts once per client (idempotent: skip if already defined on this connection).
    const client = this.redis as unknown as Record<string, unknown>;
    for (const [name, lua] of Object.entries(COMMANDS)) {
      if (typeof client[name] !== 'function') {
        this.redis.defineCommand(name, { numberOfKeys: 1, lua });
      }
    }
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async admit(key: string, cfg: BreakerConfig): Promise<Admission> {
    const max = cfg.halfOpenMax ?? 1;
    const [allow, probe, status] = await this.redis.cbAdmit(
      this.k(key),
      this.clock.now(),
      max,
      this.ttlMs,
    );
    return { allow: allow === 1, probe: probe === 1, status: status as CircuitStatus };
  }

  async record(
    key: string,
    cfg: BreakerConfig,
    ok: boolean,
    probe: boolean,
  ): Promise<CircuitStatus> {
    const status = await this.redis.cbRecord(
      this.k(key),
      ok ? 1 : 0,
      probe ? 1 : 0,
      this.clock.now(),
      cfg.threshold,
      cfg.cooldownMs,
      this.ttlMs,
    );
    return status as CircuitStatus;
  }

  async snapshot(key: string): Promise<CircuitSnapshot> {
    const [status, failures, openUntil] = await this.redis.hmget(
      this.k(key),
      'status',
      'failures',
      'openUntil',
    );
    const ou = openUntil ? Number(openUntil) : 0;
    return {
      status: (status as CircuitStatus) ?? 'closed',
      failures: failures ? Number(failures) : 0,
      ...(ou > 0 ? { openUntil: ou } : {}),
    };
  }

  async keys(opts: KeysQuery): Promise<string[]> {
    return scanKeys(this.redis, this.prefix, opts);
  }

  // ── bulkheads ──────────────────────────────────────────────────────────────────────────────

  async acquireBulkhead(key: string, cfg: BulkheadConfig): Promise<BulkheadAdmission> {
    const leaseId = randomUUID();
    const [acquired, active] = await this.redis.rlBulkheadAcquire(
      this.bulkheadPrefix + key,
      this.clock.now(),
      cfg.limit,
      cfg.leaseMs,
      leaseId,
    );
    return acquired === 1
      ? { acquired: true, leaseId, active: Number(active) }
      : { acquired: false, active: Number(active) };
  }

  async releaseBulkhead(key: string, leaseId: string): Promise<void> {
    await this.redis.rlBulkheadRelease(this.bulkheadPrefix + key, leaseId);
  }

  async bulkheadSnapshot(key: string): Promise<BulkheadSnapshot> {
    const active = await this.redis.rlBulkheadCount(this.bulkheadPrefix + key, this.clock.now());
    return { active: Number(active) };
  }

  async resetBulkhead(key: string): Promise<void> {
    await this.redis.del(this.bulkheadPrefix + key);
  }

  /** Bulkheads with at least one live slot (a set whose slots all expired is left out). */
  async bulkheadKeys(opts: KeysQuery): Promise<string[]> {
    const keys = await scanKeys(this.redis, this.bulkheadPrefix, opts);
    const now = this.clock.now();
    const counts = await Promise.all(
      keys.map((key) => this.redis.rlBulkheadCount(this.bulkheadPrefix + key, now)),
    );
    return keys.filter((_, i) => Number(counts[i]) > 0);
  }

  // ── rate limiters ──────────────────────────────────────────────────────────────────────────

  async consumeRateLimit(
    key: string,
    cfg: RateLimitConfig,
    cost: number,
  ): Promise<RateLimitDecision> {
    const [allowed, tokens, retry] = await this.redis.rlRateLimit(
      this.rateLimitPrefix + key,
      this.clock.now(),
      String(refillRate(cfg)),
      bucketCapacity(cfg),
      cost,
      bucketTtlMs(cfg),
    );
    return {
      allowed: Number(allowed) === 1,
      remaining: Math.floor(Number(tokens)),
      retryAfterMs: Number(retry),
    };
  }

  async rateLimitSnapshot(key: string): Promise<RateLimitSnapshot> {
    const [tokens, updatedAt, expiresAt] = await this.redis.hmget(
      this.rateLimitPrefix + key,
      'tokens',
      'updatedAt',
      'expiresAt',
    );
    const now = this.clock.now();
    if (tokens == null || updatedAt == null) return { now };
    if (expiresAt != null && Number(expiresAt) <= now) return { now };
    return { tokens: Number(tokens), updatedAt: Number(updatedAt), now };
  }

  async resetRateLimit(key: string): Promise<void> {
    await this.redis.del(this.rateLimitPrefix + key);
  }

  /** Buckets in use (one idle long enough to be full again is left out). */
  async rateLimitKeys(opts: KeysQuery): Promise<string[]> {
    const keys = await scanKeys(this.redis, this.rateLimitPrefix, opts);
    const snapshots = await Promise.all(keys.map((key) => this.rateLimitSnapshot(key)));
    return keys.filter((_, i) => snapshots[i]?.tokens !== undefined);
  }

  async reset(key: string): Promise<void> {
    // Deleting the hash resets the circuit: snapshot()/admit() see the closed defaults for a
    // missing key. Idempotent — DEL on an absent key is a no-op.
    await this.redis.del(this.k(key));
  }
}

/** Escape Redis glob metacharacters so a key prefix matches literally in `SCAN MATCH`. */
function globEscape(value: string): string {
  return value.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
}

/**
 * List the keys under `namespace` (+ the query prefix) with `SCAN`, stripping the namespace. Stops at
 * `limit` (capped at 1000) or when the cursor wraps. Empty when the client has no `scan`.
 */
export async function scanKeys(
  redis: RedisLike,
  namespace: string,
  opts: KeysQuery,
): Promise<string[]> {
  if (typeof redis.scan !== 'function') return [];
  const limit = Math.max(0, Math.min(1000, Math.floor(opts.limit)));
  const wanted = namespace + (opts.prefix ?? '');
  const match = `${globEscape(wanted)}*`;
  const out = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
    for (const raw of batch) {
      if (out.size >= limit) break;
      if (!raw.startsWith(wanted)) continue;
      out.add(raw.slice(namespace.length));
    }
    cursor = String(next);
  } while (cursor !== '0' && out.size < limit);
  return [...out].sort();
}

/**
 * Factory for a Redis-backed {@link ResilienceStore}. Accepts an `@adonisjs/redis` connection or a
 * raw `ioredis` client — both satisfy {@link RedisLike}. Usually you don't call this directly:
 * `config/resilience.ts` selects it via `stores.redis({ ... })` and the provider builds it for you.
 */
export function redisResilienceStore(
  redis: RedisLike,
  opts: RedisResilienceStoreOptions = {},
): RedisResilienceStore {
  return new RedisResilienceStore(redis, opts);
}
