export type { Clock } from './clock.js';
export { FakeClock, SystemClock, systemClock } from './clock.js';
export { BrokenCircuitError, TimeoutError } from './errors.js';
export type { EventSink, ResilienceEvent, ResilienceEventType } from './events.js';
export { combineSinks } from './events.js';
export { eventEmitterSink, resilienceEventName } from './integration/event_emitter.js';
export type { EventEmitterLike } from './integration/event_emitter.js';
export type { Operation, Policy, PolicyContext } from './policy.js';
export { rootContext } from './policy.js';
export { timeout } from './policies/timeout.js';
export { type Backoff, exponential, retry } from './policies/retry.js';
export { wrap } from './policies/wrap.js';
export { withResilience } from './decorator.js';
export { type CircuitBreakerOptions, circuitBreaker } from './policies/circuit_breaker.js';
export { type FailoverOptions, failover } from './policies/failover.js';
export type { ResilienceStore } from './breaker/store.js';
export type { Admission, BreakerConfig, CircuitSnapshot, CircuitStatus } from './breaker/types.js';
export { InMemoryResilienceStore } from './breaker/in_memory_store.js';
export { diagnosticsSink } from './integration/diagnostics.js';
export { tenantSuffix } from './integration/context.js';
export { INITIAL_CIRCUIT_STATE, computeAdmit, computeRecord } from './breaker/state_machine.js';
export type { CircuitState } from './breaker/state_machine.js';
export { CIRCUITS_DDL, SqlResilienceStore } from './breaker/sql.js';
export type {
  SqlDriver,
  SqlPlaceholderStyle,
  SqlResilienceStoreOptions,
  SqlTx,
} from './breaker/sql.js';
export {
  ensureResilienceSchema,
  LucidResilienceStore,
  lucidResilienceStore,
} from './stores/lucid.js';
export type {
  LucidDatabase,
  LucidQueryClient,
  LucidResilienceStoreOptions,
} from './stores/lucid.js';
export { RedisResilienceStore, redisResilienceStore } from './stores/redis.js';
export type { RedisLike, RedisResilienceStoreOptions } from './stores/redis.js';
export { stores } from './stores/factory.js';
export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  RedisStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';
export { ResilienceService } from './resilience_service.js';
export type { ResilienceServiceOptions } from './resilience_service.js';
export { defineConfig } from './define_config.js';
export type { ResilienceConfig } from './define_config.js';

// Re-export the configure hook from the package root so `node ace configure` finds it
export { configure } from '../configure.js'
