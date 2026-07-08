import { type Clock, systemClock } from '../clock.js';
import { type EventSink, policySink } from '../events.js';
import { type Operation, type Policy, type PolicyContext, rootContext } from '../policy.js';

export type Backoff = (attempt: number) => number;

export function exponential(
  baseMs: number,
  opts: { jitter?: boolean; factor?: number } = {},
): Backoff {
  const factor = opts.factor ?? 2;
  return (attempt) => {
    const raw = baseMs * factor ** attempt;
    if (!opts.jitter) return raw;
    // equal jitter: half the delay is a fixed floor, half is random spread — a 0.5×–1.0× band
    // (not full jitter, which would be a 0×–1.0× band starting from Math.random() * raw).
    return Math.round(raw * (0.5 + Math.random() / 2));
  };
}

/**
 * Retry policy. `attempts` is the total number of tries (not retries): `attempts: 3` = 1 initial
 * call + 2 retries. Emits a `retry` event before each re-attempt when a sink is configured (an
 * explicit `onEvent`, or the service-injected ambient sink on the `execute()` path).
 */
export function retry(opts: {
  attempts: number;
  backoff?: Backoff;
  clock?: Clock;
  onEvent?: EventSink;
}): Policy {
  const clock = opts.clock ?? systemClock;
  const backoff = opts.backoff ?? (() => 0);
  const onEvent = policySink(opts.onEvent);
  return {
    async execute<T>(op: Operation<T>, parent: PolicyContext = rootContext()): Promise<T> {
      let last: unknown;
      for (let attempt = 0; attempt < opts.attempts; attempt++) {
        try {
          return await op({ signal: parent.signal, attempt });
        } catch (err) {
          last = err;
          if (attempt < opts.attempts - 1) {
            onEvent({ type: 'retry', attempt: attempt + 1, error: err });
            await clock.delay(backoff(attempt), parent.signal);
          }
        }
      }
      throw last;
    },
  };
}
