import type { ResilienceStore } from '../breaker/store.js';
import type { Admission, BreakerConfig, CircuitSnapshot, CircuitStatus } from '../breaker/types.js';
import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import { ADMIT_LUA, RECORD_LUA } from './redis_lua.js';

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
}

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
}

const DEFAULT_PREFIX = 'agora:resilience:circuit:';

/**
 * Distributed circuit-breaker {@link ResilienceStore} backed by Redis. Per-circuit state lives in a
 * single Redis hash and is mutated entirely inside server-side Lua scripts, so failure counts and
 * open/half-open transitions are shared across processes and pods with no lost updates and exactly
 * one half-open probe granted under concurrency.
 *
 * The Lua branching mirrors core's pure `computeAdmit` / `computeRecord`, so a Redis-backed circuit
 * behaves identically to the in-memory and SQL stores and passes the same `runResilienceStoreContract`.
 */
export class RedisResilienceStore implements ResilienceStore {
  private readonly redis: WithCommands;
  private readonly clock: Clock;
  private readonly prefix: string;
  private readonly ttlMs: number;

  constructor(redis: RedisLike, opts: RedisResilienceStoreOptions = {}) {
    this.redis = redis as WithCommands;
    this.clock = opts.clock ?? systemClock;
    this.prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 0;
    // Register the scripts once per client (idempotent: skip if already defined on this connection).
    if (typeof this.redis.cbAdmit !== 'function') {
      this.redis.defineCommand('cbAdmit', { numberOfKeys: 1, lua: ADMIT_LUA });
    }
    if (typeof this.redis.cbRecord !== 'function') {
      this.redis.defineCommand('cbRecord', { numberOfKeys: 1, lua: RECORD_LUA });
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

  async reset(key: string): Promise<void> {
    // Deleting the hash resets the circuit: snapshot()/admit() see the closed defaults for a
    // missing key. Idempotent — DEL on an absent key is a no-op.
    await this.redis.del(this.k(key));
  }
}

/**
 * Factory for a Redis-backed {@link ResilienceStore}. Accepts an `@adonisjs/redis` connection or a
 * raw `ioredis` client — both satisfy {@link RedisLike}. Usually you don't call this directly:
 * `config/resilience.ts` selects it via `stores.redis({ ... })` and the provider builds it for you.
 */
export function redisResilienceStore(
  redis: RedisLike,
  opts: RedisResilienceStoreOptions = {},
): ResilienceStore {
  return new RedisResilienceStore(redis, opts);
}
