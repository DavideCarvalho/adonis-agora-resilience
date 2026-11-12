import { Container } from '@adonisjs/core/container';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResilienceProvider from '../providers/resilience_provider.js';
import {
  bulkhead,
  circuitBreaker,
  InMemoryResilienceStore,
  RateLimitedError,
  ResilienceService,
  rateLimiter,
} from '../src/index.js';
import {
  type ExtensionContext,
  registerTelescopeExtension,
  resilienceDashboard,
  resilienceTelescopeExtension,
  TELESCOPE_EXTENSIONS_BINDING,
  type TelescopeExtension,
} from '../src/telescope/index.js';
import type { TelescopeEntryLike, TelescopeStoreLike } from '../src/telescope/telescope-sdk.js';

const NOW = new Date('2026-11-11T12:00:00.000Z').getTime();
const MIN = 60_000;

function entry(
  id: string,
  minutesAgo: number,
  event: string,
  payload: Record<string, unknown> = {},
) {
  return {
    id,
    createdAt: new Date(NOW - minutesAgo * MIN),
    content: { lib: 'resilience', event, payload: { type: event, ...payload } },
  } satisfies TelescopeEntryLike;
}

function fakeStore(entries: TelescopeEntryLike[]): TelescopeStoreLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async list(query) {
      calls.push(query);
      return entries
        .filter((e) => !query?.after || +new Date(e.createdAt as Date) > +query.after)
        .sort((a, b) => +new Date(b.createdAt as Date) - +new Date(a.createdAt as Date));
    },
  };
}

function context(service: ResilienceService, entries: TelescopeEntryLike[] = []) {
  const store = fakeStore(entries);
  const ctx: ExtensionContext = {
    store,
    container: { make: async () => service as never },
    config: {},
  };
  return { ctx, store };
}

function provider(name: string) {
  const ext = resilienceTelescopeExtension();
  const found = ext.dataProviders?.({} as ExtensionContext).find((p) => p.name === name);
  if (!found) throw new Error(`no provider ${name}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const ENTRIES = [
  entry('e1', 5, 'retry', { policy: 'stripe', attempt: 1 }),
  entry('e2', 10, 'retry', { policy: 'stripe', attempt: 2 }),
  entry('e3', 15, 'timeout', { policy: 'search', ms: 200 }),
  entry('e4', 20, 'short-circuited', { key: 'stripe', policy: 'stripe' }),
  entry('e5', 25, 'circuit-opened', { key: 'stripe', policy: 'stripe' }),
  entry('e6', 30, 'executed', { policy: 'stripe', ok: false }),
  entry('e7', 31, 'executed', { policy: 'stripe', ok: true }),
  entry('e8', 32, 'executed', { policy: 'stripe', ok: true }),
  entry('e9', 33, 'executed', { policy: 'stripe', ok: true }),
  entry('e10', 40, 'circuit-reset', { key: 'mail', by: 'user:7', via: 'telescope' }),
  entry('e11', 45, 'rate-limited', { key: 'sms', policy: 'sms' }),
  entry('e12', 50, 'bulkhead-rejected', { key: 'pool' }),
  entry('e13', 90, 'retry', { policy: 'stripe' }),
  entry('e14', 95, 'executed', { policy: 'stripe', ok: false }),
];

describe('data providers', () => {
  it('resilience.stats counts the last hour against the hour before', async () => {
    const { ctx } = context(new ResilienceService({ emit: false }), ENTRIES);
    const stats = provider('resilience.stats');
    expect(await stats.resolve({ metric: 'retry' }, ctx)).toEqual({
      value: 2,
      delta: 1,
      deltaLabel: 'vs previous hour',
    });
    expect(await stats.resolve({ metric: 'short-circuited' }, ctx)).toMatchObject({ value: 1 });
    expect(await stats.resolve({ metric: 'error-rate' }, ctx)).toMatchObject({
      value: 0.25,
      delta: -0.75,
    });
    expect(await stats.resolve({ metric: 'bulkhead-rejected' }, ctx)).toMatchObject({ value: 1 });
  });

  it('resilience.stats reads open and half-open circuits live', async () => {
    const memory = new InMemoryResilienceStore();
    await memory.record('a', { threshold: 1, cooldownMs: 60_000 }, false, false);
    const service = new ResilienceService({
      emit: false,
      stores: { memory },
      defaultStore: 'memory',
    });
    const { ctx } = context(service);
    expect(await provider('resilience.stats').resolve({ metric: 'open' }, ctx)).toEqual({
      value: 1,
    });
    expect(await provider('resilience.stats').resolve({ metric: 'half-open' }, ctx)).toEqual({
      value: 0,
    });
  });

  it('resilience.circuits pages the live circuits and warns about the memory store', async () => {
    const memory = new InMemoryResilienceStore();
    for (const key of ['a', 'b', 'c']) {
      await memory.record(key, { threshold: 1, cooldownMs: 60_000 }, false, false);
    }
    const service = new ResilienceService({
      emit: false,
      stores: { memory },
      defaultStore: 'memory',
    });
    const { ctx } = context(service);
    const page1 = (await provider('resilience.circuits').resolve(
      { page: '1', size: '2' },
      ctx,
    )) as {
      rows: Record<string, unknown>[];
      total: number;
    };
    expect(page1.total).toBe(3);
    expect(page1.rows).toHaveLength(3);
    expect(page1.rows[0]?.key).toMatch(/memory store/);
    expect(page1.rows[1]).toMatchObject({
      key: 'a',
      status: 'open',
      store: 'memory',
      scope: 'process',
    });
    expect(page1.rows[1]?.until).toBe('in 1m');
    const page2 = (await provider('resilience.circuits').resolve({ page: 2, size: 2 }, ctx)) as {
      rows: Record<string, unknown>[];
    };
    expect(page2.rows.map((r) => r.key)).toEqual(['c']);
  });

  it('resilience.bulkheads and resilience.rate-limiters list the live limits', async () => {
    const memory = new InMemoryResilienceStore();
    const service = new ResilienceService({
      emit: false,
      stores: { memory },
      defaultStore: 'memory',
      policies: {
        pool: () => bulkhead({ key: 'pool', limit: 2 }),
        sms: () => rateLimiter({ key: 'sms', limit: 1, intervalMs: 60_000 }),
      },
    });
    let release!: () => void;
    const running = service.execute('pool', () => new Promise<void>((r) => (release = r)));
    await service.execute('sms', async () => 1);
    await expect(service.execute('sms', async () => 1)).rejects.toBeInstanceOf(RateLimitedError);
    const { ctx } = context(service);
    expect(await provider('resilience.bulkheads').resolve({}, ctx)).toEqual({
      rows: [
        { key: 'pool', policy: 'pool', active: 1, limit: 2, store: 'memory', scope: 'process' },
      ],
    });
    expect(await provider('resilience.rate-limiters').resolve({}, ctx)).toEqual({
      rows: [
        {
          key: 'sms',
          policy: 'sms',
          remaining: 0,
          rate: '1/1m',
          store: 'memory',
          scope: 'process',
        },
      ],
    });
    release();
    await running;
  });

  it('resilience.events-over-time buckets the last hour by type', async () => {
    const { ctx } = context(new ResilienceService({ emit: false }), ENTRIES);
    const { rows } = (await provider('resilience.events-over-time').resolve({}, ctx)) as {
      rows: Record<string, number | string>[];
    };
    expect(rows).toHaveLength(12);
    expect(rows.at(-1)).toMatchObject({ label: '12:00', retry: 1 });
    const total = (type: string) => rows.reduce((n, r) => n + Number(r[type]), 0);
    expect(total('retry')).toBe(2);
    expect(total('timeout')).toBe(1);
    expect(total('circuit-opened')).toBe(1);
    expect(total('rate-limited')).toBe(1);
  });

  it('resilience.noisy-policies ranks policies by retries, timeouts and rejections', async () => {
    const { ctx } = context(new ResilienceService({ emit: false }), ENTRIES);
    expect(await provider('resilience.noisy-policies').resolve({}, ctx)).toEqual({
      items: [
        { label: 'stripe', value: 3 },
        { label: '(key) pool', value: 1 },
        { label: 'search', value: 1 },
        { label: 'sms', value: 1 },
      ],
    });
  });

  it('resilience.transitions lists circuit changes and resets, newest first', async () => {
    const { ctx } = context(new ResilienceService({ emit: false }), ENTRIES);
    const { rows } = (await provider('resilience.transitions').resolve({}, ctx)) as {
      rows: Record<string, unknown>[];
    };
    expect(rows.map((r) => [r.id, r.event, r.key])).toEqual([
      ['e5', 'circuit-opened', 'stripe'],
      ['e10', 'circuit-reset', 'mail'],
    ]);
    expect(rows[1]?.detail).toBe('by user:7 via telescope');
  });

  it('shares one store read between panels resolving together', async () => {
    const { ctx, store } = context(new ResilienceService({ emit: false }), ENTRIES);
    await Promise.all([
      provider('resilience.stats').resolve({ metric: 'retry' }, ctx),
      provider('resilience.stats').resolve({ metric: 'timeout' }, ctx),
      provider('resilience.noisy-policies').resolve({}, ctx),
    ]);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ type: 'diagnostic', tag: 'lib:resilience' });
  });
});

describe('dashboard', () => {
  it('matches the page spec', () => {
    expect(resilienceDashboard()).toMatchSnapshot();
  });

  it('binds every panel to a provider the extension contributes', () => {
    const ext = resilienceTelescopeExtension();
    const names = new Set(ext.dataProviders?.({} as ExtensionContext).map((p) => p.name));
    const spec = resilienceDashboard();
    for (const section of spec.sections ?? []) {
      for (const panel of section.panels) expect(names.has(panel.data.provider)).toBe(true);
    }
  });

  it('drops the Reset button and action with reset: false', () => {
    const ext = resilienceTelescopeExtension({ reset: false });
    expect(ext.actions?.({} as ExtensionContext)).toEqual([]);
    const columns = resilienceDashboard({ reset: false }).sections?.[1]?.panels[0];
    expect(JSON.stringify(columns)).not.toContain('reset-circuit');
  });
});

describe('reset action', () => {
  it('resets the circuit as the acting user and emits circuit-reset', async () => {
    const memory = new InMemoryResilienceStore();
    const events: unknown[] = [];
    const service = new ResilienceService({
      emit: false,
      eventEmitter: { emit: (_n, e) => events.push(e) },
      stores: { memory },
      defaultStore: 'memory',
      policies: { mail: () => circuitBreaker({ key: 'mail', threshold: 1, cooldownMs: 60_000 }) },
    });
    await expect(
      service.execute('mail', () => Promise.reject(new Error('down'))),
    ).rejects.toThrow();
    const { ctx } = context(service);
    const [action] = resilienceTelescopeExtension().actions?.(ctx) ?? [];
    expect(action?.name).toBe('resilience.reset-circuit');
    expect(action?.destructive).toBe(true);
    const result = await action?.run({ key: 'mail', store: 'memory' }, { ...ctx, actor: 'user:7' });
    expect(result).toMatchObject({ key: 'mail', status: 'closed' });
    expect(events.at(-1)).toMatchObject({
      type: 'circuit-reset',
      key: 'mail',
      policy: 'mail',
      by: 'user:7',
      via: 'telescope',
    });
    await expect(action?.run({ key: '' }, ctx)).rejects.toThrow(/needs a circuit/);
    await expect(action?.run({ key: 'x', store: 'nope' }, ctx)).rejects.toThrow(
      /Unknown resilience store/,
    );
  });
});

describe('registration into agora.telescope.extensions', () => {
  function app(config: Record<string, unknown>) {
    const container = new Container();
    return {
      container,
      config: {
        get: (key: string, fallback?: unknown) => {
          const parts = key.split('.');
          let value: unknown = config;
          for (const part of parts) value = (value as Record<string, unknown> | undefined)?.[part];
          return value === undefined ? fallback : value;
        },
      },
    };
  }

  it('creates the list when no lib has', async () => {
    const a = app({ resilience: {} });
    new ResilienceProvider(a as never).register();
    const list = (await a.container.make(
      TELESCOPE_EXTENSIONS_BINDING as never,
    )) as TelescopeExtension[];
    expect(list.map((e) => e.name)).toEqual(['resilience']);
  });

  it('joins a list another lib created first, once', async () => {
    const a = app({ resilience: { telescope: { reset: false } } });
    const durable = { name: 'durable' };
    a.container.bindValue(TELESCOPE_EXTENSIONS_BINDING as never, [durable] as never);
    new ResilienceProvider(a as never).register();
    registerTelescopeExtension(a.container as never, resilienceTelescopeExtension());
    await new Promise((r) => setImmediate(r));
    const list = (await a.container.make(
      TELESCOPE_EXTENSIONS_BINDING as never,
    )) as TelescopeExtension[];
    expect(list.map((e) => e.name)).toEqual(['durable', 'resilience']);
    expect(list[1]?.actions?.({} as ExtensionContext)).toEqual([]);
  });

  it('adds nothing with telescope: false', () => {
    const a = app({ resilience: { telescope: false } });
    new ResilienceProvider(a as never).register();
    expect(a.container.hasBinding(TELESCOPE_EXTENSIONS_BINDING as never)).toBe(false);
  });
});
