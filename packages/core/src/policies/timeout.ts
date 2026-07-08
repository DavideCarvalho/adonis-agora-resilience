import { type Clock, systemClock } from '../clock.js';
import { TimeoutError } from '../errors.js';
import { type EventSink, policySink } from '../events.js';
import { type Operation, type Policy, type PolicyContext, rootContext } from '../policy.js';

export function timeout(ms: number, opts: { clock?: Clock; onEvent?: EventSink } = {}): Policy {
  const clock = opts.clock ?? systemClock;
  const onEvent = policySink(opts.onEvent);
  return {
    execute<T>(op: Operation<T>, parent: PolicyContext = rootContext()): Promise<T> {
      const ac = new AbortController();
      const onParentAbort = () => ac.abort(parent.signal.reason);
      if (parent.signal.aborted) ac.abort(parent.signal.reason);
      else parent.signal.addEventListener('abort', onParentAbort, { once: true });

      const cancelTimer = clock.setTimer(ms, () => {
        onEvent({ type: 'timeout', ms });
        ac.abort(new TimeoutError(ms));
      });
      const ctx: PolicyContext = { signal: ac.signal, attempt: parent.attempt };

      const aborted = new Promise<never>((_, reject) => {
        if (ac.signal.aborted) {
          reject(ac.signal.reason ?? new TimeoutError(ms));
          return;
        }
        ac.signal.addEventListener(
          'abort',
          () => reject(ac.signal.reason ?? new TimeoutError(ms)),
          { once: true },
        );
      });

      return Promise.race([op(ctx), aborted]).finally(() => {
        cancelTimer();
        parent.signal.removeEventListener('abort', onParentAbort);
      });
    },
  };
}
