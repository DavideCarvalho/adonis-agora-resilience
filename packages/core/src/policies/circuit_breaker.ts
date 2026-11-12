import type { ResilienceStore } from '../breaker/store.js';
import type { BreakerConfig } from '../breaker/types.js';
import { formatMs, tagDescription } from '../describe.js';
import { BrokenCircuitError } from '../errors.js';
import { currentAmbient, type EventSink, policySink } from '../events.js';
import { type Operation, type Policy, type PolicyContext, rootContext } from '../policy.js';
import { resolvePolicyStore } from '../stores/resolve.js';

export interface CircuitBreakerOptions {
  key: string;
  /**
   * Where the circuit state lives: a store instance, or the name of a store from
   * `config/resilience.ts`. Omitted: the service's default store when the policy is built by
   * `ResilienceService` (a named policy), else a process-wide in-memory store.
   */
  store?: ResilienceStore | string;
  threshold: number;
  cooldownMs: number;
  halfOpenMax?: number;
  onEvent?: EventSink;
}

export function circuitBreaker(opts: CircuitBreakerOptions): Policy {
  const ambient = currentAmbient();
  const onEvent: EventSink = policySink(opts.onEvent);
  const store = resolvePolicyStore(opts.store, 'circuit breaker');
  const observe = ambient.observe;
  const cfg: BreakerConfig = {
    threshold: opts.threshold,
    cooldownMs: opts.cooldownMs,
    ...(opts.halfOpenMax !== undefined ? { halfOpenMax: opts.halfOpenMax } : {}),
  };
  const policy: Policy = {
    async execute<T>(op: Operation<T>, parent: PolicyContext = rootContext()): Promise<T> {
      observe?.({ kind: 'circuit', key: opts.key, store, config: { ...cfg } });
      const admission = await store.admit(opts.key, cfg);
      if (admission.status === 'half-open' && admission.probe)
        onEvent({ type: 'circuit-half-open', key: opts.key });
      if (!admission.allow) {
        onEvent({ type: 'short-circuited', key: opts.key });
        throw new BrokenCircuitError(opts.key);
      }
      try {
        const result = await op({ signal: parent.signal, attempt: parent.attempt });
        const status = await store.record(opts.key, cfg, true, admission.probe);
        if (status === 'closed' && admission.probe)
          onEvent({ type: 'circuit-closed', key: opts.key });
        return result;
      } catch (err) {
        const status = await store.record(opts.key, cfg, false, admission.probe);
        if (status === 'open') onEvent({ type: 'circuit-opened', key: opts.key });
        throw err;
      }
    },
  };
  return tagDescription(policy, [
    `circuit-breaker(key=${opts.key}, threshold=${opts.threshold}, cooldown=${formatMs(opts.cooldownMs)})`,
  ]);
}
