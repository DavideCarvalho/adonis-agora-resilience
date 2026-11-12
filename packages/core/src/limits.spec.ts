import { describe, expect, it } from 'vitest';
import { InMemoryResilienceStore } from './breaker/in_memory_store.js';
import type { ResilienceStore } from './breaker/store.js';
import { FakeClock } from './clock.js';
import { BulkheadRejectedError, RateLimitedError } from './errors.js';
import type { ResilienceEvent } from './events.js';
import { consumeTokens } from './limits/token_bucket.js';
import type { BulkheadStore } from './limits/types.js';
import { bulkhead } from './policies/bulkhead.js';
import { rateLimiter } from './policies/rate_limiter.js';
import { wrap } from './policies/wrap.js';
import { ResilienceService } from './resilience_service.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

/** A bulkhead store without release notifications, like a shared store. */
function pollingStore(): BulkheadStore & ResilienceStore {
  const inner = new InMemoryResilienceStore();
  return {
    admit: (k, c) => inner.admit(k, c),
    record: (k, c, o, p) => inner.record(k, c, o, p),
    snapshot: (k) => inner.snapshot(k),
    reset: (k) => inner.reset(k),
    acquireBulkhead: (k, c) => inner.acquireBulkhead(k, c),
    releaseBulkhead: (k, id) => inner.releaseBulkhead(k, id),
    bulkheadSnapshot: (k) => inner.bulkheadSnapshot(k),
    resetBulkhead: (k) => inner.resetBulkhead(k),
  };
}

describe('bulkhead', () => {
  it('runs at most `limit` calls at once and rejects the rest when there is no queue', async () => {
    const events: ResilienceEvent[] = [];
    const store = new InMemoryResilienceStore();
    const policy = bulkhead({ key: 'b', limit: 2, store, onEvent: (e) => events.push(e) });
    const gate = deferred();
    const running = [policy.execute(() => gate.promise), policy.execute(() => gate.promise)];
    await tick();
    await expect(policy.execute(async () => 'x')).rejects.toBeInstanceOf(BulkheadRejectedError);
    expect(events).toEqual([
      { type: 'bulkhead-rejected', key: 'b', reason: 'full', active: 2, limit: 2 },
    ]);
    gate.resolve();
    await Promise.all(running);
    expect((await store.bulkheadSnapshot('b')).active).toBe(0);
  });

  it('queues callers and wakes one as soon as a slot is released (memory store)', async () => {
    const clock = new FakeClock();
    const store = new InMemoryResilienceStore(clock);
    const policy = bulkhead({ key: 'b', limit: 1, queue: 1, store, clock });
    const gate = deferred();
    const first = policy.execute(() => gate.promise);
    await tick();
    const order: string[] = [];
    const second = policy.execute(async () => {
      order.push('second');
    });
    await tick();
    await expect(policy.execute(async () => 'x')).rejects.toMatchObject({ reason: 'queue-full' });
    gate.resolve();
    await first;
    await second;
    expect(order).toEqual(['second']);
  });

  it('rejects a queued caller after queueTimeoutMs', async () => {
    const clock = new FakeClock();
    const store = pollingStore();
    const policy = bulkhead({
      key: 'b',
      limit: 1,
      queue: 5,
      queueTimeoutMs: 100,
      pollMs: 40,
      store,
      clock,
    });
    const gate = deferred();
    const first = policy.execute(() => gate.promise);
    await tick();
    const queued = policy.execute(async () => 'never').catch((e: unknown) => e);
    for (let i = 0; i < 5; i++) {
      await tick();
      clock.advance(40);
    }
    expect(await queued).toMatchObject({ reason: 'queue-timeout' });
    gate.resolve();
    await first;
  });

  it('polls a store without release notifications until a slot frees up', async () => {
    const clock = new FakeClock();
    const store = pollingStore();
    const policy = bulkhead({ key: 'b', limit: 1, queue: 1, pollMs: 10, store, clock });
    const gate = deferred();
    const first = policy.execute(() => gate.promise);
    await tick();
    const second = policy.execute(async () => 'second');
    await tick();
    gate.resolve();
    await first;
    for (let i = 0; i < 3; i++) {
      clock.advance(10);
      await tick();
    }
    await expect(second).resolves.toBe('second');
  });

  it('releases the slot when the call throws', async () => {
    const store = new InMemoryResilienceStore();
    const policy = bulkhead({ key: 'b', limit: 1, store });
    await expect(policy.execute(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect((await store.bulkheadSnapshot('b')).active).toBe(0);
  });

  it('rejects a store without bulkhead support', () => {
    const store = {
      admit() {},
      record() {},
      snapshot() {},
      reset() {},
    } as unknown as ResilienceStore;
    expect(() => bulkhead({ key: 'b', limit: 1, store })).toThrow(/does not support bulkheads/);
  });
});

describe('rateLimiter', () => {
  it('rejects over budget with RateLimitedError and a rate-limited event', async () => {
    const events: ResilienceEvent[] = [];
    const clock = new FakeClock();
    const store = new InMemoryResilienceStore(clock);
    const policy = rateLimiter({
      key: 'r',
      limit: 2,
      intervalMs: 1000,
      store,
      clock,
      onEvent: (e) => events.push(e),
    });
    await policy.execute(async () => 1);
    await policy.execute(async () => 2);
    const error = await policy.execute(async () => 3).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterMs).toBe(500);
    expect(events).toEqual([
      { type: 'rate-limited', key: 'r', retryAfterMs: 500, limit: 2, intervalMs: 1000 },
    ]);
  });

  it('waits for the budget up to maxWaitMs', async () => {
    const clock = new FakeClock();
    const store = new InMemoryResilienceStore(clock);
    const policy = rateLimiter({
      key: 'r',
      limit: 1,
      intervalMs: 100,
      maxWaitMs: 200,
      store,
      clock,
    });
    await policy.execute(async () => 'first');
    const second = policy.execute(async () => 'second');
    await tick();
    clock.advance(100);
    await expect(second).resolves.toBe('second');
  });

  it('refuses a cost above the bucket size', () => {
    expect(() => rateLimiter({ key: 'r', limit: 2, intervalMs: 1, cost: 3 })).toThrow(
      /at most the bucket size/,
    );
  });
});

describe('token bucket math', () => {
  it('is exact at the boundaries', () => {
    const cfg = { limit: 10, intervalMs: 1000 };
    const empty = consumeTokens({ tokens: 0, updatedAt: 0 }, cfg, 1, 99);
    expect(empty.decision).toEqual({ allowed: false, remaining: 0, retryAfterMs: 1 });
    expect(consumeTokens({ tokens: 0, updatedAt: 0 }, cfg, 1, 100).decision.allowed).toBe(true);
  });
});

describe('service listing', () => {
  it('lists bulkheads and rate limiters with their config, policy and live state', async () => {
    const events: ResilienceEvent[] = [];
    const memory = new InMemoryResilienceStore();
    const service = new ResilienceService({
      emit: false,
      eventEmitter: { emit: (_n, e) => events.push(e as ResilienceEvent) },
      stores: { memory },
      defaultStore: 'memory',
      policies: {
        sms: () =>
          wrap(
            rateLimiter({ key: 'sms', limit: 10, intervalMs: 60_000 }),
            bulkhead({ key: 'sms-pool', limit: 3, queue: 2 }),
          ),
      },
    });
    const gate = deferred();
    const running = service.execute('sms', () => gate.promise);
    await tick();

    expect(await service.bulkheads()).toEqual([
      {
        key: 'sms-pool',
        store: 'memory',
        policy: 'sms',
        active: 1,
        limit: 3,
        queue: 2,
        scope: 'process',
      },
    ]);
    expect(await service.rateLimiters()).toEqual([
      {
        key: 'sms',
        store: 'memory',
        policy: 'sms',
        remaining: 9,
        limit: 10,
        intervalMs: 60_000,
        scope: 'process',
      },
    ]);
    expect(await service.getBulkhead('sms-pool')).toMatchObject({ active: 1 });
    expect(await service.getRateLimiter('sms')).toMatchObject({ remaining: 9 });
    gate.resolve();
    await running;
    expect(service.describePolicies()).toEqual([
      {
        name: 'sms',
        kinds: ['rate-limiter(key=sms, 10/1m)', 'bulkhead(key=sms-pool, limit=3, queue=2)'],
      },
    ]);
  });

  it('stamps bulkhead and rate-limit events with the policy name', async () => {
    const events: ResilienceEvent[] = [];
    const service = new ResilienceService({
      emit: false,
      eventEmitter: { emit: (_n, e) => events.push(e as ResilienceEvent) },
      policies: { tight: () => rateLimiter({ key: 'tight', limit: 1, intervalMs: 60_000 }) },
    });
    await service.execute('tight', async () => 1);
    await expect(service.execute('tight', async () => 2)).rejects.toBeInstanceOf(RateLimitedError);
    expect(events.at(-1)).toMatchObject({ type: 'rate-limited', key: 'tight', policy: 'tight' });
  });
});
