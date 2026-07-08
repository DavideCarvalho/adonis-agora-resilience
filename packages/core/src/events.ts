export type ResilienceEventType =
  | 'circuit-opened'
  | 'circuit-closed'
  | 'circuit-half-open'
  | 'short-circuited'
  | 'failover'
  | 'timeout'
  | 'retry';

export interface ResilienceEvent {
  type: ResilienceEventType;
  key?: string;
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

/**
 * Process-wide fallback sink. Policies emit here when built without an explicit `onEvent`, letting
 * the {@link import('./resilience_service.js').ResilienceService} inject its own sink into policies
 * produced by named-policy factories — which have no way to receive a sink through the public
 * `() => Policy` signature. Set only for the synchronous window in which a factory builds its
 * policy; see {@link withAmbientSink}.
 */
let ambientSink: EventSink = noopSink;

/**
 * Run `build` with `sink` installed as the ambient fallback, restoring the previous value
 * afterwards. Synchronous by design: policies capture their effective sink at build time (see
 * {@link policySink}), so the service brackets a factory call with this to inject its sink without
 * an async race — the set→build→restore runs to completion between event-loop turns.
 */
export function withAmbientSink<T>(sink: EventSink, build: () => T): T {
  const previous = ambientSink;
  ambientSink = sink;
  try {
    return build();
  } finally {
    ambientSink = previous;
  }
}

/**
 * The effective sink for a policy: its own `onEvent` (when given) combined with the ambient
 * fallback, so an explicitly-passed sink and a service-injected one BOTH receive events. Call at
 * policy build time to capture the ambient sink then in effect.
 */
export function policySink(onEvent?: EventSink): EventSink {
  return combineSinks(onEvent ?? noopSink, ambientSink);
}
