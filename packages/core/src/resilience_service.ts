import { InMemoryResilienceStore } from './breaker/in_memory_store.js';
import type { ResilienceStore } from './breaker/store.js';
import type { CircuitSnapshot, CircuitStatus } from './breaker/types.js';
import { describePolicy } from './describe.js';
import {
  combineSinks,
  type EventSink,
  type KeyObservation,
  noopSink,
  type PolicyAmbient,
  type ResilienceEvent,
  withAmbient,
} from './events.js';
import { defaultSanitizeError, diagnosticsSink } from './integration/diagnostics.js';
import { type EventEmitterLike, eventEmitterSink } from './integration/event_emitter.js';
import { type FailoverOptions, failover } from './policies/failover.js';
import type { Operation, Policy } from './policy.js';
import { KnownKeys } from './visibility/known_keys.js';
import {
  type RecentEvent,
  RecentEvents,
  type RecentEventsQuery,
} from './visibility/recent_events.js';

/** The slice of a logger the service writes audit lines to (the AdonisJS logger fits). */
export interface ResilienceLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

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
  /**
   * Also emit an `executed` event (`{ policy, ok, ms, attempts, error? }`) after every call to a
   * named policy, for call counts and error rates. Default false: it is one event per call.
   */
  executedEvents?: boolean;
  /** Mirror resilience events to an EventEmitter2-style emitter as well. */
  eventEmitter?: EventEmitterLike;
  /** Where manual circuit resets are logged. The provider passes the app logger. */
  logger?: ResilienceLogger;
}

/** Where a circuit's state lives: shared by every process, or held by this process only. */
export type StoreScope = 'cluster' | 'process';

/** One circuit, as listed by {@link ResilienceService.circuits}. */
export interface CircuitInfo {
  key: string;
  /** The store name from config (`'(default)'` for an unnamed default store, `'(custom)'` otherwise). */
  store: string;
  /** The named policy that last used it in this process, when known. */
  policy?: string;
  status: CircuitStatus;
  failures: number;
  /** Epoch ms the cooldown ends, when open. */
  openUntil?: number;
  /** `process` for the in-memory store: the state belongs to this process only. */
  scope: StoreScope;
  /** The breaker's `threshold`, when this process has used the circuit. */
  threshold?: number;
  /** The breaker's `cooldownMs`, when this process has used the circuit. */
  cooldownMs?: number;
}

/** Filters for {@link ResilienceService.circuits}. */
export interface CircuitsQuery {
  /** Only this store (a name from config). Default: every configured store. */
  store?: string;
  status?: CircuitStatus;
  prefix?: string;
  /** Default 100, at most 1000. */
  limit?: number;
}

/** One named policy, as described by {@link ResilienceService.describePolicies}. */
export interface PolicyDescription {
  name: string;
  /** One line per building block: `['timeout(2s)', 'retry(3, exp 200ms)']`; `['custom']` when unknown. */
  kinds: string[];
  /** Set when the policy factory throws while being built. */
  error?: string;
}

/** Who reset a circuit, for the audit line and the `circuit-reset` event. */
export interface ResetOptions {
  /** The store name from config. Default: the default store. */
  store?: string;
  /** Who asked: `'user:42'`, `'token:3f9a…'`, `'cli'`. */
  by?: string;
  /** Where from: `'telescope'`, `'mcp'`, `'cli'`, `'api'`. */
  via?: string;
}

const DEFAULT_STORE_LABEL = '(default)';
const CUSTOM_STORE_LABEL = '(custom)';
const STATUS_ORDER: Record<CircuitStatus, number> = { open: 0, 'half-open': 1, closed: 2 };

/**
 * The container-resolved entry point for resilience. Holds the configured store(s)
 * and event sink, runs operations through named or ad-hoc policies, and exposes
 * failover, per-circuit inspection/reset, and what this process knows about its policies.
 */
export class ResilienceService {
  readonly sink: EventSink;
  readonly store: ResilienceStore;
  private readonly stores: Record<string, ResilienceStore>;
  private readonly policies: Record<string, () => Policy>;
  private readonly executedEvents: boolean;
  private readonly logger: ResilienceLogger | undefined;
  /** @internal the keys stateful policies touched in this process. */
  readonly known = new KnownKeys(1000);
  private readonly recent = new RecentEvents(200);
  private descriptions?: PolicyDescription[];

  constructor(options: ResilienceServiceOptions = {}) {
    this.stores = options.stores ?? {};
    this.store =
      options.store ??
      (options.defaultStore ? this.requireStore(options.defaultStore) : undefined) ??
      new InMemoryResilienceStore();
    const base = options.emit === false ? noopSink : diagnosticsSink();
    this.sink = combineSinks(
      (event) => this.remember(event),
      base,
      options.eventEmitter ? eventEmitterSink(options.eventEmitter) : noopSink,
    );
    this.policies = options.policies ?? {};
    this.executedEvents = options.executedEvents === true;
    this.logger = options.logger;
  }

  /** Run `op` through a named policy or an ad-hoc {@link Policy}. */
  execute<T>(policy: string | Policy, op: Operation<T>): Promise<T> {
    if (typeof policy !== 'string') return policy.execute(op);
    const factory = this.policies[policy];
    if (!factory) throw new Error(`Unknown resilience policy "${policy}".`);
    return this.executeNamed(policy, factory, op);
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

  /** The names of the configured stores. */
  storeNames(): string[] {
    return Object.keys(this.stores);
  }

  /** Inspect or reset a single circuit by key, on the default store (or the named one). */
  circuit(key: string, storeName?: string) {
    const store = this.circuitStore(storeName);
    return {
      snapshot: (): Promise<CircuitSnapshot> => store.snapshot(key),
      reset: async (): Promise<void> => {
        await this.resetCircuit(key, { ...(storeName ? { store: storeName } : {}), via: 'api' });
      },
    };
  }

  /**
   * Force a circuit back to closed, then emit `circuit-reset` (`{ key, store, by, via }`) and log one
   * audit line. Returns the circuit as it reads afterwards.
   */
  async resetCircuit(key: string, opts: ResetOptions = {}): Promise<CircuitInfo> {
    const store = this.circuitStore(opts.store);
    const before = await store.snapshot(key);
    await store.reset(key);
    const storeLabel = this.storeName(store);
    const event: ResilienceEvent = {
      type: 'circuit-reset',
      key,
      store: storeLabel,
      previous: before.status,
      ...(opts.by !== undefined ? { by: opts.by } : {}),
      ...(opts.via !== undefined ? { via: opts.via } : {}),
    };
    const policy = this.known.get('circuit', key)?.policy;
    if (policy !== undefined) event.policy = policy;
    this.sink(event);
    this.logger?.info(
      {
        resilience: 'circuit-reset',
        key,
        store: storeLabel,
        previous: before.status,
        by: opts.by,
        via: opts.via,
      },
      `[@adonis-agora/resilience] circuit "${key}" reset (was ${before.status})`,
    );
    return this.circuitInfo(key, store);
  }

  /** One circuit with its live state. */
  async getCircuit(key: string, storeName?: string): Promise<CircuitInfo> {
    return this.circuitInfo(key, this.circuitStore(storeName));
  }

  /**
   * Every circuit this deployment knows: the keys the store lists (when it can), plus the keys this
   * process used, with their live state. Open circuits first.
   */
  async circuits(query: CircuitsQuery = {}): Promise<CircuitInfo[]> {
    const limit = clampLimit(query.limit, 100, 1000);
    const targets = query.store ? [this.requireStore(query.store)] : this.allStores();
    const keysByStore = new Map<ResilienceStore, Set<string>>();
    const add = (store: ResilienceStore, key: string) => {
      if (query.prefix !== undefined && !key.startsWith(query.prefix)) return;
      let set = keysByStore.get(store);
      if (!set) {
        set = new Set();
        keysByStore.set(store, set);
      }
      set.add(key);
    };
    for (const store of targets) {
      if (typeof store.keys === 'function') {
        const keys = await store.keys({
          ...(query.prefix !== undefined ? { prefix: query.prefix } : {}),
          limit,
        });
        for (const key of keys) add(store, key);
      }
    }
    for (const known of this.known.list('circuit')) {
      const store = known.store as ResilienceStore;
      if (query.store && store !== targets[0]) continue;
      add(store, known.key);
    }
    const infos: CircuitInfo[] = [];
    for (const [store, keys] of keysByStore) {
      for (const key of keys) infos.push(await this.circuitInfo(key, store));
    }
    return infos
      .filter((c) => query.status === undefined || c.status === query.status)
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  /** The names under `policies` in config. */
  policyNames(): string[] {
    return Object.keys(this.policies);
  }

  /**
   * What each named policy is made of. Builds each factory once (with no events and no traffic) and
   * reads the description the built-in policies carry; custom policies read `['custom']`.
   */
  describePolicies(): PolicyDescription[] {
    if (this.descriptions) return this.descriptions;
    const out: PolicyDescription[] = [];
    let failed = false;
    for (const [name, factory] of Object.entries(this.policies)) {
      try {
        const { observe: _observe, ...context } = this.ambientFor(name, noopSink);
        const policy = withAmbient(context, factory);
        out.push({ name, kinds: describePolicy(policy) });
      } catch (err) {
        failed = true;
        out.push({ name, kinds: [], error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!failed) this.descriptions = out;
    return out;
  }

  /** The most recent resilience events in THIS process (newest first, at most 200 kept). */
  recentEvents(query: RecentEventsQuery = {}): RecentEvent[] {
    return this.recent.list(query);
  }

  /** The store's name from config, `'(default)'` for an unnamed default store, else `'(custom)'`. */
  storeName(store: unknown): string {
    for (const [name, candidate] of Object.entries(this.stores)) {
      if (candidate === store) return name;
    }
    return store === this.store ? DEFAULT_STORE_LABEL : CUSTOM_STORE_LABEL;
  }

  /** `process` when the state lives in this process only (the in-memory store). */
  storeScope(store: unknown): StoreScope {
    return store instanceof InMemoryResilienceStore ? 'process' : 'cluster';
  }

  /** @internal The build context a named policy is built in. */
  protected ambientFor(name: string, sink: EventSink): PolicyAmbient {
    return {
      sink,
      policy: name,
      store: (storeName) => this.circuitStore(storeName),
      observe: (observation: KeyObservation) =>
        this.known.record({ ...observation, policy: name, seenAt: Date.now() }),
    };
  }

  private async executeNamed<T>(name: string, factory: () => Policy, op: Operation<T>): Promise<T> {
    let retries = 0;
    const sink: EventSink = (event) => {
      if (event.type === 'retry') retries += 1;
      this.sink({ ...event, policy: name });
    };
    const policy = withAmbient(this.ambientFor(name, sink), factory);
    if (!this.executedEvents) return policy.execute(op);
    const started = performance.now();
    try {
      const result = await policy.execute(op);
      this.sink({
        type: 'executed',
        policy: name,
        ok: true,
        ms: elapsed(started),
        attempts: retries + 1,
      });
      return result;
    } catch (error) {
      this.sink({
        type: 'executed',
        policy: name,
        ok: false,
        ms: elapsed(started),
        attempts: retries + 1,
        error,
      });
      throw error;
    }
  }

  private async circuitInfo(key: string, store: ResilienceStore): Promise<CircuitInfo> {
    const snapshot = await store.snapshot(key);
    const known = this.known.get('circuit', key);
    const sameStore = known?.store === store;
    const info: CircuitInfo = {
      key,
      store: this.storeName(store),
      status: snapshot.status,
      failures: snapshot.failures,
      scope: this.storeScope(store),
    };
    if (snapshot.openUntil !== undefined) info.openUntil = snapshot.openUntil;
    if (sameStore && known?.policy !== undefined) info.policy = known.policy;
    const config = sameStore ? known?.config : undefined;
    if (typeof config?.threshold === 'number') info.threshold = config.threshold;
    if (typeof config?.cooldownMs === 'number') info.cooldownMs = config.cooldownMs;
    return info;
  }

  /** Every distinct store: the named ones, then the default when it is not one of them. */
  private allStores(): ResilienceStore[] {
    const out = [...new Set(Object.values(this.stores))];
    if (!out.includes(this.store)) out.push(this.store);
    return out;
  }

  private remember(event: ResilienceEvent): void {
    const kept: RecentEvent = { ...event, at: Date.now() };
    if ('error' in event) kept.error = defaultSanitizeError(event.error);
    this.recent.push(kept);
  }

  private requireStore(name: string): ResilienceStore {
    const store = this.stores[name];
    if (!store) throw new Error(`Unknown resilience store "${name}".`);
    return store;
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

/** Clamp a caller-supplied limit to `[1, max]`, `fallback` when absent or invalid. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}
