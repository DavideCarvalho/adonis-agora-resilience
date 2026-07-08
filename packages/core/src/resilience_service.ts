import { InMemoryResilienceStore } from './breaker/in_memory_store.js';
import type { ResilienceStore } from './breaker/store.js';
import type { CircuitSnapshot } from './breaker/types.js';
import { type EventSink, combineSinks, noopSink, withAmbientSink } from './events.js';
import { diagnosticsSink } from './integration/diagnostics.js';
import { type EventEmitterLike, eventEmitterSink } from './integration/event_emitter.js';
import { type FailoverOptions, failover } from './policies/failover.js';
import type { Operation, Policy } from './policy.js';

/** Options for {@link ResilienceService} — the runtime shape built from `config/resilience.ts`. */
export interface ResilienceServiceOptions {
  /**
   * An explicit circuit-breaker store. Takes precedence over `stores`/`defaultStore`. Defaults to an
   * in-process {@link InMemoryResilienceStore} when neither is provided.
   */
  store?: ResilienceStore;
  /**
   * Resolved named circuit-breaker stores. Built by the provider from `config.stores`
   * (a {@link import('./stores/factory.js').StoreProvider} map). Resolve one by name with
   * {@link ResilienceService.circuitStore}.
   */
  stores?: Record<string, ResilienceStore>;
  /** Name of the default store (a key of `stores`) returned by {@link ResilienceService.store}. */
  defaultStore?: string;
  /** Named, reusable policy factories resolvable by name in {@link ResilienceService.execute}. */
  policies?: Record<string, () => Policy>;
  /** Emit diagnostics events on `agora:resilience:*`. Default true. */
  emit?: boolean;
  /** Mirror resilience events to an EventEmitter2-style emitter as well. */
  eventEmitter?: EventEmitterLike;
}

/**
 * The container-resolved entry point for resilience. Holds the configured store(s)
 * and event sink, runs operations through named or ad-hoc policies, and exposes
 * failover + per-circuit inspection/reset.
 *
 * The AdonisJS counterpart of the NestJS `ResilienceService` — same surface, but
 * constructed from `config/resilience.ts` instead of DI tokens, and without the
 * decorator/explorer path (wrap your operations with the exported policy
 * functions, or register named policies here).
 */
export class ResilienceService {
  readonly sink: EventSink;
  readonly store: ResilienceStore;
  private readonly stores: Record<string, ResilienceStore>;
  private readonly policies: Record<string, () => Policy>;

  constructor(options: ResilienceServiceOptions = {}) {
    this.stores = options.stores ?? {};
    this.store =
      options.store ??
      (options.defaultStore ? this.requireStore(options.defaultStore) : undefined) ??
      new InMemoryResilienceStore();
    const base = options.emit === false ? noopSink : diagnosticsSink();
    this.sink = options.eventEmitter
      ? combineSinks(base, eventEmitterSink(options.eventEmitter))
      : base;
    this.policies = options.policies ?? {};
  }

  /** Run `op` through a named policy or an ad-hoc {@link Policy}. */
  execute<T>(policy: string | Policy, op: Operation<T>): Promise<T> {
    const resolved = typeof policy === 'string' ? this.resolve(policy) : policy;
    return resolved.execute(op);
  }

  /** Ordered failover across targets, wired to this service's event sink. */
  failover<TTarget, R>(opts: FailoverOptions<TTarget, R>): Promise<R> {
    return failover({ onEvent: this.sink, ...opts });
  }

  /**
   * Resolve a circuit-breaker store. With no argument returns the default {@link store}; with a name
   * returns the configured store under that key (throws if unknown). Useful for wiring an explicit
   * `circuitBreaker({ store: resilience.circuitStore('redis') })`.
   */
  circuitStore(name?: string): ResilienceStore {
    return name ? this.requireStore(name) : this.store;
  }

  /** Inspect or reset a single circuit by key, on the default store. */
  circuit(key: string) {
    const store = this.store;
    return {
      snapshot: (): Promise<CircuitSnapshot> => store.snapshot(key),
      reset: (): Promise<void> => store.reset(key),
    };
  }

  private requireStore(name: string): ResilienceStore {
    const store = this.stores[name];
    if (!store) throw new Error(`Unknown resilience store "${name}".`);
    return store;
  }

  /**
   * Build a named policy, injecting this service's {@link sink} as the ambient fallback for the
   * synchronous window in which the factory constructs its policy. Policies built here (e.g. a
   * `circuitBreaker`/`timeout`/`retry` from `config/resilience.ts`) then emit to diagnostics + the
   * configured EventEmitter without the public `() => Policy` signature having to carry a sink. An
   * `onEvent` the factory passes explicitly is preserved — both fire (see {@link policySink}).
   */
  private resolve(name: string): Policy {
    const factory = this.policies[name];
    if (!factory) throw new Error(`Unknown resilience policy "${name}".`);
    return withAmbientSink(this.sink, factory);
  }
}
