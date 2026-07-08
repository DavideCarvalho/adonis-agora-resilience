import type { ResilienceStore } from '../breaker/store.js';
import type { BreakerConfig } from '../breaker/types.js';
import { BrokenCircuitError } from '../errors.js';
import { type EventSink, policySink } from '../events.js';
import { type Operation, type Policy, type PolicyContext, rootContext } from '../policy.js';

export interface CircuitBreakerOptions {
  key: string;
  store: ResilienceStore;
  threshold: number;
  cooldownMs: number;
  halfOpenMax?: number;
  onEvent?: EventSink;
}

export function circuitBreaker(opts: CircuitBreakerOptions): Policy {
  const onEvent: EventSink = policySink(opts.onEvent);
  const cfg: BreakerConfig = {
    threshold: opts.threshold,
    cooldownMs: opts.cooldownMs,
    ...(opts.halfOpenMax !== undefined ? { halfOpenMax: opts.halfOpenMax } : {}),
  };
  return {
    async execute<T>(op: Operation<T>, parent: PolicyContext = rootContext()): Promise<T> {
      const admission = await opts.store.admit(opts.key, cfg);
      if (admission.status === 'half-open' && admission.probe)
        onEvent({ type: 'circuit-half-open', key: opts.key });
      if (!admission.allow) {
        onEvent({ type: 'short-circuited', key: opts.key });
        throw new BrokenCircuitError(opts.key);
      }
      try {
        const result = await op({ signal: parent.signal, attempt: parent.attempt });
        const status = await opts.store.record(opts.key, cfg, true, admission.probe);
        if (status === 'closed' && admission.probe)
          onEvent({ type: 'circuit-closed', key: opts.key });
        return result;
      } catch (err) {
        const status = await opts.store.record(opts.key, cfg, false, admission.probe);
        if (status === 'open') onEvent({ type: 'circuit-opened', key: opts.key });
        throw err;
      }
    },
  };
}
