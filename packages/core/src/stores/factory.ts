import type { ApplicationService } from '@adonisjs/core/types';
import { InMemoryResilienceStore } from '../breaker/in_memory_store.js';
import type { ResilienceStore } from '../breaker/store.js';
import type { Clock } from '../clock.js';
import type { LucidResilienceStoreOptions } from './lucid.js';
import type { RedisResilienceStoreOptions } from './redis.js';

/**
 * Runtime context a {@link StoreProvider} receives when the resilience provider builds the
 * configured circuit store at boot.
 */
export interface StoreContext {
  /** The booted application — used to resolve connections (Lucid `db`, Redis), etc. */
  app: ApplicationService;
}

/**
 * A configured circuit-breaker store: a thunk the resilience provider calls at boot to build the
 * {@link ResilienceStore}. Each provider imports its peer dependency (`@adonisjs/lucid`,
 * `@adonisjs/redis`/`ioredis`) inside the thunk, so the driver is only loaded for a store that is
 * listed in the config `stores` map — the provider builds every listed store at boot. A peer you
 * never list is never imported, keeping those packages optional.
 */
export type StoreProvider = (ctx: StoreContext) => Promise<ResilienceStore>;

/** Options for the built-in in-memory store. */
export interface MemoryStoreConfig {
  /** Clock used for cooldown math. Defaults to the system clock. */
  clock?: Clock;
}

/** Options for the Lucid (SQL) store, plus the connection to resolve. */
export interface LucidStoreConfig extends LucidResilienceStoreOptions {
  /** `@adonisjs/lucid` connection name. Defaults to the default connection. */
  connection?: string;
}

/** Options for the Redis store, plus the connection to resolve. */
export interface RedisStoreConfig extends RedisResilienceStoreOptions {
  /** `@adonisjs/redis` connection name. Defaults to the default connection. */
  connection?: string;
}

/**
 * The store factory namespace used in `config/resilience.ts`:
 *
 * ```ts
 * import { defineConfig, stores } from '@adonis-agora/resilience'
 *
 * export default defineConfig({
 *   default: 'memory',
 *   stores: {
 *     memory: stores.memory(),
 *     lucid: stores.lucid({ connection: 'pg' }),
 *     redis: stores.redis({ connection: 'main' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link StoreProvider} — a lazy thunk. Calling it in the config file costs
 * nothing; the peer dependency is imported when the provider builds the store at boot, which it does
 * for every store listed in the `stores` map (not only the `default` one).
 */
export const stores = {
  /** In-process circuit store — single process, no peer dependency. */
  memory(config: MemoryStoreConfig = {}): StoreProvider {
    return async () =>
      config.clock ? new InMemoryResilienceStore(config.clock) : new InMemoryResilienceStore();
  },

  /** SQL circuit store backed by `@adonisjs/lucid` (Postgres / MySQL / SQLite). */
  lucid(config: LucidStoreConfig = {}): StoreProvider {
    return async () => {
      const db = (await import('@adonisjs/lucid/services/db')).default;
      const { lucidResilienceStore } = await import('./lucid.js');
      const { connection, ...opts } = config;
      const client = connection
        ? (db.connection(connection) as unknown as import('./lucid.js').LucidDatabase)
        : (db as unknown as import('./lucid.js').LucidDatabase);
      return lucidResilienceStore(client, opts);
    };
  },

  /** Distributed circuit store backed by `@adonisjs/redis` / `ioredis`. */
  redis(config: RedisStoreConfig = {}): StoreProvider {
    return async () => {
      const redisService = (await import('@adonisjs/redis/services/main')).default;
      const { redisResilienceStore } = await import('./redis.js');
      const { connection, ...opts } = config;
      const conn = connection
        ? redisService.connection(connection as Parameters<typeof redisService.connection>[0])
        : redisService.connection();
      // The raw ioredis client behind the AdonisJS connection satisfies RedisLike.
      const client = (conn as unknown as { ioConnection: import('./redis.js').RedisLike })
        .ioConnection;
      return redisResilienceStore(client, opts);
    };
  },
};
