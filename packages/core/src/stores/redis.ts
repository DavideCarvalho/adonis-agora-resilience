import type { KeysQuery, ResilienceStore } from '../breaker/store.js';
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

  async keys(opts: KeysQuery): Promise<string[]> {
    return scanKeys(this.redis, this.prefix, opts);
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
 * `limit` (capped at 500) or when the cursor wraps. Empty when the client has no `scan`.
 */
export async function scanKeys(
  redis: RedisLike,
  namespace: string,
  opts: KeysQuery,
): Promise<string[]> {
  if (typeof redis.scan !== 'function') return [];
  const limit = Math.max(0, Math.min(500, Math.floor(opts.limit)));
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
): ResilienceStore {
  return new RedisResilienceStore(redis, opts);
}
