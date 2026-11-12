import type { ResilienceServiceOptions } from './resilience_service.js';
import { type StoreProvider, stores } from './stores/factory.js';
import type { ResilienceTelescopeOptions } from './telescope/extension.js';

/**
 * Shape of `config/resilience.ts`. Extends {@link ResilienceServiceOptions} (named policies, event
 * emission) with a config-driven circuit store: pick a `default` store and list the stores you use
 * under `stores`, built with the {@link stores} factory. The in-memory store is used when no
 * `default`/`stores` are configured.
 */
export interface ResilienceConfig
  extends Omit<ResilienceServiceOptions, 'stores' | 'defaultStore' | 'logger'> {
  /**
   * Name of the store (a key of `stores`) used as the circuit-breaker store. Omit to use the
   * built-in in-memory store (or an explicit `store`).
   */
  default?: string;
  /** Named circuit-breaker stores, built with the {@link stores} factory. */
  stores?: Record<string, StoreProvider>;
  /**
   * The "Resilience" page in `@adonis-agora/telescope`, added on its own when telescope is installed.
   * `false` leaves it out; `{ reset: false }` hides the Reset button. Default `true`.
   */
  telescope?: boolean | ResilienceTelescopeOptions;
  /**
   * Developer tools on `@adonis-agora/agent`'s dev MCP endpoint (`/mcp/agora`), gated by its
   * `devTools.authorize`. Default `true`; `false` leaves them out.
   */
  devTools?: boolean;
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
