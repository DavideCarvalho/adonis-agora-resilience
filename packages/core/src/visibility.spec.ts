import { describe, expect, it, vi } from 'vitest';
import { InMemoryResilienceStore } from './breaker/in_memory_store.js';
import type { ResilienceStore } from './breaker/store.js';
import { FakeClock } from './clock.js';
import type { ResilienceEvent } from './events.js';
import { circuitBreaker } from './policies/circuit_breaker.js';
import { exponential, retry } from './policies/retry.js';
import { timeout } from './policies/timeout.js';
import { wrap } from './policies/wrap.js';
import type { Policy } from './policy.js';
import { ResilienceService } from './resilience_service.js';
import { processMemoryStore } from './stores/resolve.js';
import { KnownKeys } from './visibility/known_keys.js';
import { InvalidCursorError, RecentEvents } from './visibility/recent_events.js';

const fail = () => Promise.reject(new Error('boom'));
const ok = () => Promise.resolve('ok');

function collecting(options: ConstructorParameters<typeof ResilienceService>[0] = {}) {
  const events: ResilienceEvent[] = [];
  const service = new ResilienceService({
    emit: false,
    eventEmitter: { emit: (_name, event) => events.push(event as ResilienceEvent) },
    ...options,
  });
  return { service, events };
}

/** A store without `keys()`, like a third-party one. */
function opaqueStore(): ResilienceStore {
  const inner = new InMemoryResilienceStore();
  return {
    admit: (k, c) => inner.admit(k, c),
    record: (k, c, o, p) => inner.record(k, c, o, p),
    snapshot: (k) => inner.snapshot(k),
    reset: (k) => inner.reset(k),
  };
}

describe('policy name on events', () => {
  it('stamps every event of a named policy with the policy name', async () => {
    const clock = new FakeClock();
    const store = new InMemoryResilienceStore(clock);
    const { service, events } = collecting({
      store,
      policies: {
        stripe: () =>
          wrap(
            retry({ attempts: 2 }),
            circuitBreaker({ key: 'stripe', threshold: 1, cooldownMs: 100 }),
          ),
        slow: () => timeout(5, { clock }),
      },
    });
    await expect(service.execute('stripe', fail)).rejects.toThrow();
    clock.advance(100);
    await service.execute('stripe', ok);
    const slow = service.execute('slow', () => new Promise(() => {}));
    clock.advance(5);
    await expect(slow).rejects.toThrow();

    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'circuit-opened',
        'retry',
        'short-circuited',
        'circuit-half-open',
        'circuit-closed',
        'timeout',
      ]),
    );
    for (const event of events) {
      expect(event.policy).toBe(event.type === 'timeout' ? 'slow' : 'stripe');
    }
    expect(events.find((e) => e.type === 'circuit-opened')?.key).toBe('stripe');
  });

  it('leaves the policy out for inline policies and stamps explicit onEvent sinks too', async () => {
    const own: ResilienceEvent[] = [];
    const { service, events } = collecting({
      policies: { named: () => retry({ attempts: 2, onEvent: (e) => own.push(e) }) },
    });
    await expect(service.execute(retry({ attempts: 2 }), fail)).rejects.toThrow();
    expect(events).toEqual([]);
    await expect(service.execute('named', fail)).rejects.toThrow();
    expect(own[0]?.policy).toBe('named');
    expect(events[0]?.policy).toBe('named');
  });

  it('stamps failover events run inside a named policy and keeps the caller onEvent alongside', async () => {
    const own: ResilienceEvent[] = [];
    const { service, events } = collecting({ policies: { sms: () => retry({ attempts: 1 }) } });
    await service.execute('sms', () =>
      service.failover({
        targets: ['twilio', 'vonage'],
        run: async (target) => {
          if (target === 'twilio') throw new Error('down');
          return target;
        },
        onEvent: (e) => own.push(e),
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'failover', target: 'twilio', policy: 'sms' }),
    ]);
    expect(own).toEqual([expect.objectContaining({ type: 'failover', policy: 'sms' })]);
    await expect(
      service.failover({ targets: ['a'], run: () => Promise.reject(new Error('x')) }),
    ).rejects.toThrow('x');
    expect(events.at(-1)?.policy).toBeUndefined();
  });
});

describe('executed event', () => {
  it('is off by default', async () => {
    const { service, events } = collecting({ policies: { p: () => retry({ attempts: 1 }) } });
    await service.execute('p', ok);
    expect(events.filter((e) => e.type === 'executed')).toEqual([]);
  });

  it('reports ok, duration and attempts when enabled', async () => {
    let calls = 0;
    const { service, events } = collecting({
      executedEvents: true,
      policies: { p: () => retry({ attempts: 3 }) },
    });
    await service.execute('p', async () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return 'ok';
    });
    const executed = events.filter((e) => e.type === 'executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ policy: 'p', ok: true, attempts: 3 });
    expect(typeof executed[0]?.ms).toBe('number');
  });

  it('reports failures with the error and rethrows', async () => {
    const { service, events } = collecting({
      executedEvents: true,
      policies: { p: () => retry({ attempts: 2 }) },
    });
    await expect(service.execute('p', fail)).rejects.toThrow('boom');
    expect(events.at(-1)).toMatchObject({ type: 'executed', policy: 'p', ok: false, attempts: 2 });
    expect(events.at(-1)?.error).toMatchObject({ message: 'boom' });
  });
});

describe('known keys index', () => {
  it('is bounded per kind, evicting the least recently used key', () => {
    const index = new KnownKeys(1000);
    for (let i = 0; i < 1005; i++) {
      index.record({ kind: 'circuit', key: `k${i}`, store: null, seenAt: i });
    }
    index.record({ kind: 'circuit', key: 'k5', store: null, seenAt: 2000 });
    index.record({ kind: 'circuit', key: 'k1005', store: null, seenAt: 2001 });
    expect(index.size('circuit')).toBe(1000);
    expect(index.get('circuit', 'k5', null)).toBeDefined();
    expect(index.get('circuit', 'k6', null)).toBeUndefined();
    expect(index.list('circuit')[0]?.key).toBe('k1005');
  });

  it('keeps the last known policy when a later touch has none', () => {
    const index = new KnownKeys();
    index.record({ kind: 'circuit', key: 'a', store: null, policy: 'p', seenAt: 1 });
    index.record({ kind: 'circuit', key: 'a', store: null, seenAt: 2 });
    expect(index.get('circuit', 'a', null)?.policy).toBe('p');
  });

  it('keeps the same key on two stores apart', () => {
    const index = new KnownKeys();
    const a = {};
    const b = {};
    index.record({ kind: 'circuit', key: 'k', store: a, policy: 'pa', seenAt: 1 });
    index.record({ kind: 'circuit', key: 'k', store: b, policy: 'pb', seenAt: 2 });
    expect(index.get('circuit', 'k', a)?.policy).toBe('pa');
    expect(index.get('circuit', 'k', b)?.policy).toBe('pb');
    expect(index.size('circuit')).toBe(2);
  });
});

describe('circuits()', () => {
  it('lists the circuits the store holds plus the ones this process used, open first', async () => {
    const memory = new InMemoryResilienceStore();
    const service = new ResilienceService({
      emit: false,
      stores: { memory },
      defaultStore: 'memory',
      policies: { pay: () => circuitBreaker({ key: 'pay', threshold: 1, cooldownMs: 60_000 }) },
    });
    await memory.record('other', { threshold: 5, cooldownMs: 1 }, false, false);
    await expect(service.execute('pay', fail)).rejects.toThrow();

    const { data: circuits } = await service.circuits();
    expect(circuits.map((c) => c.key)).toEqual(['pay', 'other']);
    expect(circuits[0]).toMatchObject({
      key: 'pay',
      store: 'memory',
      policy: 'pay',
      status: 'open',
      failures: 1,
      scope: 'process',
      threshold: 1,
      cooldownMs: 60_000,
    });
    expect(circuits[1]).toMatchObject({ key: 'other', status: 'closed', failures: 1 });
    expect(circuits[1]?.policy).toBeUndefined();

    expect((await service.circuits({ status: 'open' })).data.map((c) => c.key)).toEqual(['pay']);
    expect((await service.circuits({ prefix: 'oth' })).data.map((c) => c.key)).toEqual(['other']);
    const firstOnly = await service.circuits({ first: 1 });
    expect(firstOnly.data.map((c) => c.key)).toEqual(['pay']);
    expect(firstOnly.meta).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasNext: true,
      hasPrev: false,
    });
    expect((await service.circuits({ first: 2 })).meta.hasNext).toBe(false);
  });

  it('falls back to the keys seen in this process when the store cannot list keys', async () => {
    const shared = opaqueStore();
    const service = new ResilienceService({
      emit: false,
      stores: { shared },
      defaultStore: 'shared',
      policies: { a: () => circuitBreaker({ key: 'a', threshold: 3, cooldownMs: 1 }) },
    });
    expect((await service.circuits()).data).toEqual([]);
    await service.execute('a', ok);
    const [circuit] = (await service.circuits({ store: 'shared' })).data;
    expect(circuit).toMatchObject({
      key: 'a',
      store: 'shared',
      status: 'closed',
      scope: 'cluster',
    });
  });

  it('resolves a store by name for a named policy and rejects names outside the service', async () => {
    const memory = new InMemoryResilienceStore();
    const other = new InMemoryResilienceStore();
    const service = new ResilienceService({
      emit: false,
      stores: { memory, other },
      defaultStore: 'memory',
      policies: {
        b: () => circuitBreaker({ key: 'b', store: 'other', threshold: 1, cooldownMs: 10 }),
      },
    });
    await expect(service.execute('b', fail)).rejects.toThrow('boom');
    expect((await other.snapshot('b')).status).toBe('open');
    expect((await memory.snapshot('b')).status).toBe('closed');
    expect(() => circuitBreaker({ key: 'x', store: 'other', threshold: 1, cooldownMs: 1 })).toThrow(
      /only works for a policy registered under `policies`/,
    );
  });

  it('uses one process-wide memory store for breakers built without a store', async () => {
    const breaker = circuitBreaker({ key: 'standalone-test', threshold: 1, cooldownMs: 60_000 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect((await processMemoryStore().snapshot('standalone-test')).status).toBe('open');
    await processMemoryStore().reset('standalone-test');
  });
});

describe('resetCircuit()', () => {
  it('closes the circuit, emits circuit-reset and logs one audit line', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const memory = new InMemoryResilienceStore();
    const { service, events } = collecting({ stores: { memory }, defaultStore: 'memory', logger });
    await memory.record('k', { threshold: 1, cooldownMs: 60_000 }, false, false);

    const after = await service.resetCircuit('k', { by: 'user:1', via: 'telescope' });
    expect(after).toMatchObject({ key: 'k', status: 'closed', failures: 0, store: 'memory' });
    expect(events.at(-1)).toMatchObject({
      type: 'circuit-reset',
      key: 'k',
      store: 'memory',
      previous: 'open',
      by: 'user:1',
      via: 'telescope',
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ key: 'k', by: 'user:1' });
  });

  it('circuit(key).reset() goes through the same path', async () => {
    const { service, events } = collecting();
    await service.circuit('k').reset();
    expect(events.at(-1)).toMatchObject({ type: 'circuit-reset', key: 'k', via: 'api' });
  });
});

describe('policy catalogue', () => {
  it('describes each built-in policy, wrap, and custom policies', () => {
    const custom: Policy = {
      execute: (op) => op({ signal: new AbortController().signal, attempt: 0 }),
    };
    const service = new ResilienceService({
      emit: false,
      policies: {
        stripe: () =>
          wrap(
            timeout(2000),
            retry({ attempts: 3, backoff: exponential(200) }),
            circuitBreaker({ key: 'stripe', threshold: 5, cooldownMs: 30_000 }),
          ),
        plain: () => retry({ attempts: 2 }),
        fancy: () => retry({ attempts: 2, backoff: () => 1 }),
        custom: () => custom,
        broken: () => {
          throw new Error('no key');
        },
      },
    });
    expect(service.policyNames()).toEqual(['stripe', 'plain', 'fancy', 'custom', 'broken']);
    expect(service.describePolicies()).toEqual([
      {
        name: 'stripe',
        kinds: [
          'timeout(2s)',
          'retry(3, exp 200ms)',
          'circuit-breaker(key=stripe, threshold=5, cooldown=30s)',
        ],
      },
      { name: 'plain', kinds: ['retry(2)'] },
      { name: 'fancy', kinds: ['retry(2, custom backoff)'] },
      { name: 'custom', kinds: ['custom'] },
      { name: 'broken', kinds: [], error: 'no key' },
    ]);
  });

  it('keeps the description out of enumerable keys', () => {
    expect(Object.keys(timeout(10))).toEqual(['execute']);
    expect(JSON.stringify(retry({ attempts: 1 }))).toBe('{}');
  });

  it('does not index keys while describing', () => {
    const service = new ResilienceService({
      emit: false,
      policies: { c: () => circuitBreaker({ key: 'c', threshold: 1, cooldownMs: 1 }) },
    });
    service.describePolicies();
    expect(service.known.size('circuit')).toBe(0);
  });
});

describe('recent events', () => {
  it('keeps the last 200 events, newest first, with sanitized errors', async () => {
    const service = new ResilienceService({
      emit: false,
      policies: { p: () => retry({ attempts: 2 }) },
    });
    const secret = Object.assign(new Error('nope'), { token: 'sk-live' });
    await expect(service.execute('p', () => Promise.reject(secret))).rejects.toThrow();
    const [event] = service.recentEvents().data;
    expect(event).toMatchObject({
      type: 'retry',
      policy: 'p',
      error: { name: 'Error', message: 'nope' },
    });
    expect(JSON.stringify(event)).not.toContain('sk-live');
    expect(typeof event?.at).toBe('number');
  });

  it('is bounded and filters by type, key and policy', () => {
    const ring = new RecentEvents(200);
    for (let i = 0; i < 250; i++) {
      ring.push({
        type: i % 2 ? 'retry' : 'timeout',
        key: `k${i % 3}`,
        policy: `p${i % 5}`,
        at: i,
      });
    }
    expect(ring.size).toBe(200);
    expect(ring.list({ first: 1000 }).data).toHaveLength(200);
    expect(ring.list({ first: 1 }).data[0]?.at).toBe(249);
    expect(ring.list({ first: 1000 }).data.at(-1)?.at).toBe(50);
    expect(ring.list().data).toHaveLength(20);
    expect(ring.list({ type: 'retry', first: 1000 }).data.every((e) => e.type === 'retry')).toBe(
      true,
    );
    expect(ring.list({ key: 'k1', first: 1000 }).data.every((e) => e.key === 'k1')).toBe(true);
    expect(ring.list({ policy: 'p2', first: 3 }).data).toHaveLength(3);
    expect(ring.list({ type: ['retry', 'timeout'], first: 5 }).data).toHaveLength(5);
  });

  it('pages with cursors, forward and backward, stable while new events arrive', () => {
    const ring = new RecentEvents(50);
    for (let i = 0; i < 30; i++) ring.push({ type: 'retry', key: `k${i % 2}`, at: i });

    // Forward through k0's events (newest first), 4 at a time.
    const forward: number[] = [];
    let page = ring.list({ key: 'k0', first: 4 });
    expect(page.meta).toMatchObject({ hasPrev: false, prevCursor: null, hasNext: true });
    const pages = [page];
    forward.push(...page.data.map((e) => e.at));
    while (page.meta.nextCursor) {
      // New events between pages do not shift the walk.
      ring.push({ type: 'retry', key: 'k0', at: 1000 + forward.length });
      page = ring.list({ key: 'k0', first: 4, after: page.meta.nextCursor });
      expect(page.meta.hasPrev).toBe(true);
      pages.push(page);
      forward.push(...page.data.map((e) => e.at));
    }
    expect(forward).toEqual([28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2, 0]);
    expect(page.meta).toMatchObject({ hasNext: false, nextCursor: null });

    // Backward from the last page returns the page before it.
    const last = pages.at(-1)!;
    const back = ring.list({ key: 'k0', last: 4, before: last.meta.prevCursor! });
    expect(back.data.map((e) => e.at)).toEqual(pages.at(-2)!.data.map((e) => e.at));
    expect(back.meta.hasNext).toBe(true);

    // Backward from the second page reaches the first page and the events that arrived since.
    const newer = ring.list({ key: 'k0', last: 100, before: pages[1]!.meta.prevCursor! });
    const arrived = newer.data.filter((e) => e.at >= 1000);
    expect(arrived.length).toBeGreaterThan(0);
    expect(newer.data.slice(arrived.length).map((e) => e.at)).toEqual([28, 26, 24, 22]);
    expect(newer.meta).toMatchObject({ hasPrev: false, prevCursor: null, hasNext: true });

    expect(() => ring.list({ after: 'not-a-cursor' })).toThrow(InvalidCursorError);
  });
});
