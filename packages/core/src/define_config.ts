import type { ResilienceServiceOptions } from './resilience_service.js';
import { type StoreProvider, stores } from './stores/factory.js';

/**
 * Shape of `config/resilience.ts`. Extends {@link ResilienceServiceOptions} (named policies, event
 * emission) with a config-driven circuit store: pick a `default` store and list the stores you use
 * under `stores`, built with the {@link stores} factory. The in-memory store is used when no
 * `default`/`stores` are configured.
 */
export interface ResilienceConfig
  extends Omit<ResilienceServiceOptions, 'stores' | 'defaultStore'> {
  /**
   * Name of the store (a key of `stores`) used as the circuit-breaker store. Omit to use the
   * built-in in-memory store (or an explicit `store`).
   */
  default?: string;
  /** Named circuit-breaker stores, built with the {@link stores} factory. */
  stores?: Record<string, StoreProvider>;
}

/** Identity helper giving `config/resilience.ts` full type-checking. */
export function defineConfig(config: ResilienceConfig): ResilienceConfig {
  return config;
}

export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  RedisStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';
export type {
  LucidDatabase,
  LucidQueryClient,
  LucidResilienceStoreOptions,
} from './stores/lucid.js';
export type { RedisLike, RedisResilienceStoreOptions } from './stores/redis.js';
export { stores };
