import type { ResilienceStore } from '../breaker/store.js';
import { type Clock, systemClock } from '../clock.js';
import { tagDescription } from '../describe.js';
import { BulkheadRejectedError, type BulkheadRejection } from '../errors.js';
import { currentAmbient, type EventSink, policySink } from '../events.js';
import { type BulkheadConfig, type BulkheadStore, isBulkheadStore } from '../limits/types.js';
import { type Operation, type Policy, type PolicyContext, rootContext } from '../policy.js';
import { resolvePolicyStore } from '../stores/resolve.js';

export interface BulkheadOptions {
  /** The bulkhead's name; calls sharing a key share its slots. */
  key: string;
  /** How many calls may run at once. */
  limit: number;
  /** How many calls may wait for a slot (in this process). Default 0: reject when full. */
  queue?: number;
  /** How long a queued call waits for a slot before it is rejected. Default 10s. */
  queueTimeoutMs?: number;
  /**
   * How long a slot stays taken if the process holding it dies before releasing it (shared stores).
   * Default 60s; set it above your slowest call.
   */
  leaseMs?: number;
  /** How often a queued call re-checks a shared store. Default 50ms. */
  pollMs?: number;
  /**
   * Where the slots live: a store instance, or the name of a store from `config/resilience.ts`.
   * Omitted: the service's default store in a named policy, else a process-wide in-memory store.
   */
  store?: (ResilienceStore & BulkheadStore) | BulkheadStore | string;
  clock?: Clock;
  onEvent?: EventSink;
}

/** Calls waiting for a slot in this process, per store and key. */
const waiting = new WeakMap<object, Map<string, number>>();

function waitingCount(store: object, key: string): number {
  return waiting.get(store)?.get(key) ?? 0;
}

function addWaiting(store: object, key: string, delta: number): void {
  let map = waiting.get(store);
  if (!map) {
    map = new Map();
    waiting.set(store, map);
  }
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

/**
 * Bulkhead: at most `limit` calls run at once. Extra calls wait in a queue of at most `queue` (for at
 * most `queueTimeoutMs`), or are rejected with {@link BulkheadRejectedError}. With a shared store
 * (Redis, Lucid) the limit holds across every process.
 */
export function bulkhead(opts: BulkheadOptions): Policy {
  if (!(opts.limit >= 1)) throw new Error(`bulkhead "${opts.key}": limit must be at least 1`);
  const ambient = currentAmbient();
  const onEvent = policySink(opts.onEvent);
  const store = resolvePolicyStore(opts.store as ResilienceStore | string | undefined, 'bulkhead');
  if (!isBulkheadStore(store)) {
    throw new Error(`bulkhead "${opts.key}": the store does not support bulkheads`);
  }
  const clock = opts.clock ?? systemClock;
  const queue = Math.max(0, opts.queue ?? 0);
  const queueTimeoutMs = opts.queueTimeoutMs ?? 10_000;
  const pollMs = Math.max(1, opts.pollMs ?? 50);
  const cfg: BulkheadConfig = { limit: opts.limit, leaseMs: opts.leaseMs ?? 60_000 };
  const observe = ambient.observe;

  const reject = (reason: BulkheadRejection, active: number): never => {
    onEvent({ type: 'bulkhead-rejected', key: opts.key, reason, active, limit: opts.limit });
    throw new BulkheadRejectedError(opts.key, reason);
  };

  /** Wait for a release (memory store) or one poll interval (shared stores), whichever first. */
  const pause = (ms: number, signal: AbortSignal): Promise<void> => {
    const subscribe = store.onBulkheadRelease?.bind(store);
    if (!subscribe) return clock.delay(ms, signal);
    return new Promise<void>((resolve, reject) => {
      const ac = new AbortController();
      const done = () => {
        unsubscribe();
        ac.abort();
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        done();
        reject(signal.reason);
      };
      const unsubscribe = subscribe(opts.key, () => {
        done();
        resolve();
      });
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      clock.delay(ms, ac.signal).then(
        () => {
          done();
          resolve();
        },
        () => {},
      );
    });
  };

  const acquire = async (signal: AbortSignal): Promise<string> => {
    const first = await store.acquireBulkhead(opts.key, cfg);
    if (first.acquired) return first.leaseId as string;
    if (waitingCount(store, opts.key) >= queue)
      return reject(queue === 0 ? 'full' : 'queue-full', first.active);
    addWaiting(store, opts.key, 1);
    try {
      const deadline = clock.now() + queueTimeoutMs;
      let active = first.active;
      for (;;) {
        const left = deadline - clock.now();
        if (left <= 0) return reject('queue-timeout', active);
        await pause(Math.min(pollMs, left), signal);
        const next = await store.acquireBulkhead(opts.key, cfg);
        if (next.acquired) return next.leaseId as string;
        active = next.active;
      }
    } finally {
      addWaiting(store, opts.key, -1);
    }
  };

  const policy: Policy = {
    async execute<T>(op: Operation<T>, parent: PolicyContext = rootContext()): Promise<T> {
      observe?.({ kind: 'bulkhead', key: opts.key, store, config: { limit: opts.limit, queue } });
      const leaseId = await acquire(parent.signal);
      try {
        return await op({ signal: parent.signal, attempt: parent.attempt });
      } finally {
        await store.releaseBulkhead(opts.key, leaseId);
      }
    },
  };
  return tagDescription(policy, [
    `bulkhead(key=${opts.key}, limit=${opts.limit}${queue > 0 ? `, queue=${queue}` : ''})`,
  ]);
}
