import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResilienceStore } from './breaker/store.js';

export type ResilienceEventType =
  | 'circuit-opened'
  | 'circuit-closed'
  | 'circuit-half-open'
  | 'circuit-reset'
  | 'short-circuited'
  | 'failover'
  | 'timeout'
  | 'retry'
  | 'executed'
  | 'bulkhead-rejected'
  | 'rate-limited';

export interface ResilienceEvent {
  type: ResilienceEventType;
  key?: string;
  /** The named policy the event happened in (`execute('stripe', op)` → `'stripe'`). Absent for inline policies. */
  policy?: string;
  [extra: string]: unknown;
}

export type EventSink = (event: ResilienceEvent) => void;

export const noopSink: EventSink = () => {};

/** Fan one event out to several sinks (errors in one do not stop the others). */
export function combineSinks(...sinks: EventSink[]): EventSink {
  const active = sinks.filter((s): s is EventSink => typeof s === 'function');
  if (active.length === 0) return noopSink;
  if (active.length === 1) return active[0] as EventSink;
  return (event) => {
    for (const s of active) {
      try {
        s(event);
      } catch {
        // a misbehaving sink must not break the others or the policy
      }
    }
  };
}

/** The kinds of keyed state a policy keeps in a store. */
export type StatefulKind = 'circuit' | 'bulkhead' | 'rate-limiter';

/**
 * What a stateful policy reports to the service each time it touches a key, so the service can list
 * the keys it has seen even on stores that cannot enumerate their own keys.
 */
export interface KeyObservation {
  kind: StatefulKind;
  key: string;
  store: unknown;
  /** The policy's static config for that key (threshold, limit, …), for listings. */
  config?: Record<string, unknown>;
}

/**
 * The build-time context a policy captures. Set by {@link ResilienceService} for the synchronous
 * window in which a named-policy factory runs; empty everywhere else.
 */
export interface PolicyAmbient {
  sink: EventSink;
  /** The named policy being built. */
  policy?: string;
  /** Resolve a store by name (or the default one), for policies built without an explicit store. */
  store?: (name?: string) => ResilienceStore;
  /** Report a key a stateful policy touched. */
  observe?: (observation: KeyObservation) => void;
}

const EMPTY_AMBIENT: PolicyAmbient = { sink: noopSink };

/**
 * Process-wide build context. Policies read it when they are built without an explicit `onEvent`
 * or store, letting the {@link import('./resilience_service.js').ResilienceService} inject its own
 * sink, policy name and stores into policies produced by named-policy factories (whose public
 * signature is `() => Policy`). Set only for the synchronous window in which a factory builds its
 * policy; see {@link withAmbient}.
 */
let ambient: PolicyAmbient = EMPTY_AMBIENT;

/**
 * Run `build` with `context` installed as the ambient build context, restoring the previous one
 * afterwards. Synchronous by design: policies capture what they need at build time, so the
 * set→build→restore runs to completion between event-loop turns.
 */
export function withAmbient<T>(context: PolicyAmbient, build: () => T): T {
  const previous = ambient;
  ambient = context;
  try {
    return build();
  } finally {
    ambient = previous;
  }
}

/** Shorthand for {@link withAmbient} with a sink only. */
export function withAmbientSink<T>(sink: EventSink, build: () => T): T {
  return withAmbient({ sink }, build);
}

/** The build context in effect right now (call at policy build time). */
export function currentAmbient(): PolicyAmbient {
  return ambient;
}

/**
 * The effective sink for a policy: its own `onEvent` (when given) combined with the ambient
 * fallback, so an explicitly-passed sink and a service-injected one BOTH receive events. Call at
 * policy build time to capture the ambient sink then in effect.
 */
export function policySink(onEvent?: EventSink): EventSink {
  const sink = combineSinks(onEvent ?? noopSink, ambient.sink);
  const policy = ambient.policy;
  if (policy === undefined) return sink;
  // Stamp before fanning out, so an explicit `onEvent` sees the same event the service does.
  return (event) => sink(event.policy === undefined ? { ...event, policy } : event);
}

/** The named policy currently executing (set by `ResilienceService.execute(name, …)` for the call). */
const running = new AsyncLocalStorage<string>();

/** Run `fn` as part of the named policy `name` (async context, for events emitted at run time). */
export function runInPolicy<T>(name: string, fn: () => T): T {
  return running.run(name, fn);
}

/** The named policy the current async context runs in, if any. */
export function currentPolicy(): string | undefined {
  return running.getStore();
}
