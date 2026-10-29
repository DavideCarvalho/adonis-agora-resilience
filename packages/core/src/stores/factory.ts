import type { ApplicationService } from '@adonisjs/core/types';
import {
  InMemoryResilienceStore,
  type InMemoryResilienceStoreOptions,
} from '../breaker/in_memory_store.js';
import type { ResilienceStore } from '../breaker/store.js';
import type { Clock } from '../clock.js';
import type { LucidDatabase, LucidResilienceStoreOptions } from './lucid.js';
import type { RedisLike, RedisResilienceStoreOptions } from './redis.js';

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

/**
 * Options for the built-in in-memory store. `maxEntries`/`ttlMs` are recommended whenever the
 * circuit `key` folds in caller-influenced input (e.g. a tenant id) — see
 * {@link InMemoryResilienceStoreOptions}.
 */
export interface MemoryStoreConfig extends InMemoryResilienceStoreOptions {
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
 * Resolve a peer service (`redis`, `lucid.db`) for a store thunk the provider runs at boot.
 *
 * The container binding is registered in the peer provider's `register()`, so it exists while the
 * resilience service is being built. The `services/main` / `services/db` default export does NOT:
 * it is only assigned in `app.booted()`, so a `ResilienceService` resolved during boot (a class
 * injected into something the app instantiates while booting) read `undefined` and failed with
 * `Cannot read properties of undefined (reading 'connection')`. The service module stays as the
 * fallback for a context without the binding.
 */
async function resolveService<T>(
  ctx: StoreContext | undefined,
  binding: string,
  fromModule: () => Promise<unknown>,
  method: string,
): Promise<T> {
  const looksRight = (value: unknown): value is T =>
    typeof (value as Record<string, unknown> | undefined)?.[method] === 'function';
  if (ctx?.app) {
    try {
      const bound = await ctx.app.container.make(binding as never);
      if (looksRight(bound)) return bound;
    } catch {
      // Not bound (the peer provider is missing): fall through to the service module.
    }
  }
  // The peer package itself may not be installed: that is the same "missing provider" case.
  const fromService = await fromModule().catch(() => undefined);
  if (looksRight(fromService)) return fromService;
  throw new Error(
    `@adonis-agora/resilience: the store needs the '${binding}' service. Register its provider ` +
      'in adonisrc.ts before the resilience provider.',
  );
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
    return async () => {
      const { clock, ...opts } = config;
      return new InMemoryResilienceStore(clock, opts);
    };
  },

  /** SQL circuit store backed by `@adonisjs/lucid` (Postgres / MySQL / SQLite). */
  lucid(config: LucidStoreConfig = {}): StoreProvider {
    return async (ctx) => {
      const db = await resolveService<{ connection(name: string): unknown }>(
        ctx,
        'lucid.db',
        async () => (await import('@adonisjs/lucid/services/db')).default,
        'connection',
      );
      const { lucidResilienceStore } = await import('./lucid.js');
      const { connection, ...opts } = config;
      const client = (connection ? db.connection(connection) : db) as unknown as LucidDatabase;
      return lucidResilienceStore(client, opts);
    };
  },

  /** Distributed circuit store backed by `@adonisjs/redis` / `ioredis`. */
  redis(config: RedisStoreConfig = {}): StoreProvider {
    return async (ctx) => {
      const redisService = await resolveService<{ connection(name?: string): unknown }>(
        ctx,
        'redis',
        async () => (await import('@adonisjs/redis/services/main')).default,
        'connection',
      );
      const { redisResilienceStore } = await import('./redis.js');
      const { connection, ...opts } = config;
      const conn = connection ? redisService.connection(connection) : redisService.connection();
      // The raw ioredis client behind the AdonisJS connection satisfies RedisLike.
      const client = (conn as { ioConnection: RedisLike }).ioConnection;
      return redisResilienceStore(client, opts);
    };
  },
};
