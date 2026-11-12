// Re-export the configure hook from the package root so `node ace configure` finds it
export { configure } from '../configure.js';
export type { InMemoryResilienceStoreOptions } from './breaker/in_memory_store.js';
export { InMemoryResilienceStore } from './breaker/in_memory_store.js';
export type {
  ResilienceSchemaOptions,
  ResilienceSchemaReport,
  ResilienceTableNames,
  SqlDialect,
  SqlDriver,
  SqlPlaceholderStyle,
  SqlResilienceStoreOptions,
  SqlTx,
} from './breaker/sql.js';
export {
  assertSchemaName,
  BULKHEADS_DDL,
  bulkheadsDdl,
  CIRCUITS_DDL,
  circuitsDdl,
  MYSQL_KEY_LENGTH,
  quoteIdentifier,
  RATE_LIMITS_DDL,
  RESILIENCE_DDL,
  rateLimitsDdl,
  resilienceDdl,
  resilienceTableNames,
  SqlResilienceStore,
} from './breaker/sql.js';
export type { CircuitState } from './breaker/state_machine.js';
export { computeAdmit, computeRecord, INITIAL_CIRCUIT_STATE } from './breaker/state_machine.js';
export type { KeysQuery, ResilienceStore } from './breaker/store.js';
export type { Admission, BreakerConfig, CircuitSnapshot, CircuitStatus } from './breaker/types.js';
export type { Clock } from './clock.js';
export { FakeClock, SystemClock, systemClock } from './clock.js';
export { withResilience } from './decorator.js';
export type { ResilienceConfig } from './define_config.js';
export { defineConfig } from './define_config.js';
export { describePolicy } from './describe.js';
export type { BulkheadRejection } from './errors.js';
export {
  BrokenCircuitError,
  BulkheadRejectedError,
  RateLimitedError,
  TimeoutError,
} from './errors.js';
export type {
  EventSink,
  ResilienceEvent,
  ResilienceEventType,
  StatefulKind,
} from './events.js';
export { combineSinks } from './events.js';
export { tenantSuffix } from './integration/context.js';
export type { DiagnosticsSinkOptions } from './integration/diagnostics.js';
export { defaultSanitizeError, diagnosticsSink } from './integration/diagnostics.js';
export type {
  ResilienceBusError,
  ResilienceChannels,
} from './integration/diagnostics_types.js';
export type { EventEmitterLike } from './integration/event_emitter.js';
export { eventEmitterSink, resilienceEventName } from './integration/event_emitter.js';
export type {
  BulkheadAdmission,
  BulkheadConfig,
  BulkheadSnapshot,
  BulkheadStore,
  RateLimitConfig,
  RateLimitDecision,
  RateLimitSnapshot,
  RateLimitStore,
} from './limits/types.js';
export { isBulkheadStore, isRateLimitStore } from './limits/types.js';
export { type BulkheadOptions, bulkhead } from './policies/bulkhead.js';
export { type CircuitBreakerOptions, circuitBreaker } from './policies/circuit_breaker.js';
export { type FailoverOptions, failover } from './policies/failover.js';
export { type RateLimiterOptions, rateLimiter } from './policies/rate_limiter.js';
export { type Backoff, exponential, retry } from './policies/retry.js';
export { timeout } from './policies/timeout.js';
export { wrap } from './policies/wrap.js';
export type { Operation, Policy, PolicyContext } from './policy.js';
export { rootContext } from './policy.js';
export type {
  BulkheadInfo,
  CircuitInfo,
  CircuitsQuery,
  LimitsQuery,
  PolicyDescription,
  RateLimiterInfo,
  ResetOptions,
  ResilienceLogger,
  ResilienceServiceOptions,
  StoreScope,
} from './resilience_service.js';
export { ResilienceService } from './resilience_service.js';
export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  RedisStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';
export { stores } from './stores/factory.js';
export type {
  LucidDatabase,
  LucidQueryClient,
  LucidResilienceStoreOptions,
} from './stores/lucid.js';
export {
  ensureResilienceSchema,
  LucidResilienceStore,
  lucidResilienceStore,
} from './stores/lucid.js';
export type { RedisLike, RedisResilienceStoreOptions } from './stores/redis.js';
export { RedisResilienceStore, redisResilienceStore } from './stores/redis.js';
export type { RecentEvent, RecentEventsQuery } from './visibility/recent_events.js';
