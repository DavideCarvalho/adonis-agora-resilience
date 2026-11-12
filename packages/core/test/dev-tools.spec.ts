import { describe, expect, it, vi } from 'vitest';
import type { DevTool, DevToolCall, DevToolsHub, DevToolsLib } from '../src/dev_tools/contract.js';
import { pageOf, registerDevTools, resilienceDevTools } from '../src/dev_tools/tools.js';
import {
  bulkhead,
  circuitBreaker,
  InMemoryResilienceStore,
  ResilienceService,
  rateLimiter,
  retry,
} from '../src/index.js';

const call: DevToolCall = {
  ctx: {},
  caller: { id: 'token:3f9a1c2b7d10', via: 'token' },
  limits: { maxRows: 100, maxBytes: 48_000 },
};

async function setup() {
  const memory = new InMemoryResilienceStore();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new ResilienceService({
    emit: false,
    stores: { memory },
    defaultStore: 'memory',
    logger,
    policies: {
      stripe: () => circuitBreaker({ key: 'stripe', threshold: 1, cooldownMs: 60_000 }),
      flaky: () => retry({ attempts: 2 }),
      pool: () => bulkhead({ key: 'pool', limit: 2 }),
      sms: () => rateLimiter({ key: 'sms', limit: 5, intervalMs: 60_000 }),
    },
  });
  await expect(
    service.execute('stripe', () => Promise.reject(new Error('down'))),
  ).rejects.toThrow();
  await expect(service.execute('flaky', () => Promise.reject(new Error('x')))).rejects.toThrow();
  await service.execute('pool', async () => 1);
  await service.execute('sms', async () => 1);
  const tools = resilienceDevTools(async () => service);
  const tool = (name: string) => tools.find((t) => t.name === name) as DevTool;
  return { service, tools, tool, logger, memory };
}

describe('resilience dev tools', () => {
  it('follows the hub naming rules and only uses the input-schema subset', async () => {
    const { tools } = await setup();
    expect(tools.map((t) => [t.name, t.kind])).toEqual([
      ['resilience_list_policies', 'read'],
      ['resilience_list_circuits', 'read'],
      ['resilience_get_circuit', 'read'],
      ['resilience_list_bulkheads', 'read'],
      ['resilience_list_rate_limiters', 'read'],
      ['resilience_list_recent_events', 'read'],
      ['resilience_reset_circuit', 'action'],
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^resilience_[a-z0-9]+(_[a-z0-9]+)+$/);
      expect(t.input.type).toBe('object');
      for (const prop of Object.values(t.input.properties)) {
        expect(['string', 'number', 'integer', 'boolean', 'array']).toContain(prop.type);
      }
    }
    expect(tools.find((t) => t.kind === 'action')?.destructive).toBe(true);
  });

  it('resilience_list_policies describes the named policies', async () => {
    const { tool } = await setup();
    const out = (await tool('resilience_list_policies').run({}, call)) as { items: unknown[] };
    expect(out.items).toContainEqual({ name: 'flaky', kinds: ['retry(2)'] });
  });

  it('resilience_list_circuits filters and pages', async () => {
    const { tool } = await setup();
    expect(await tool('resilience_list_circuits').run({ status: 'open' }, call)).toEqual({
      items: [expect.objectContaining({ key: 'stripe', status: 'open', policy: 'stripe' })],
      next: null,
    });
    expect(await tool('resilience_list_circuits').run({ status: 'half-open' }, call)).toEqual({
      items: [],
      next: null,
    });
  });

  it('resilience_get_circuit returns the circuit and its last events', async () => {
    const { tool } = await setup();
    const out = (await tool('resilience_get_circuit').run({ key: 'stripe' }, call)) as {
      circuit: { status: string };
      recentEvents: { type: string }[];
    };
    expect(out.circuit.status).toBe('open');
    expect(out.recentEvents.map((e) => e.type)).toEqual(['circuit-opened']);
  });

  it('lists bulkheads and rate limiters', async () => {
    const { tool } = await setup();
    expect(await tool('resilience_list_bulkheads').run({}, call)).toEqual({
      items: [expect.objectContaining({ key: 'pool', active: 0, limit: 2, policy: 'pool' })],
      next: null,
    });
    expect(await tool('resilience_list_rate_limiters').run({}, call)).toEqual({
      items: [expect.objectContaining({ key: 'sms', remaining: 4, limit: 5 })],
      next: null,
    });
  });

  it('resilience_list_recent_events says it is this process only and filters', async () => {
    const { tool } = await setup();
    const out = (await tool('resilience_list_recent_events').run({ type: 'retry' }, call)) as {
      items: { type: string; policy: string }[];
      scope: string;
    };
    expect(out.scope).toBe('this process');
    expect(out.items).toEqual([expect.objectContaining({ type: 'retry', policy: 'flaky' })]);
  });

  it('resilience_reset_circuit resets as the caller and writes the audit line', async () => {
    const { tool, logger, service } = await setup();
    const out = await tool('resilience_reset_circuit').run(
      { key: 'stripe', store: 'memory' },
      call,
    );
    expect(out).toMatchObject({ key: 'stripe', status: 'closed' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'stripe', by: 'token:3f9a1c2b7d10', via: 'mcp' }),
      expect.any(String),
    );
    expect(service.recentEvents({ type: 'circuit-reset' })[0]).toMatchObject({
      by: 'token:3f9a1c2b7d10',
      via: 'mcp',
    });
  });

  it('rejects a missing or empty key instead of reading or resetting a phantom circuit', async () => {
    const { tool, logger } = await setup();
    await expect(tool('resilience_get_circuit').run({}, call)).rejects.toThrow(/`key` is required/);
    await expect(tool('resilience_reset_circuit').run({ key: '  ' }, call)).rejects.toThrow(
      /`key` is required/,
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('pageOf caps limit at 100 and links the next page', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    expect(pageOf(items, {}).items).toHaveLength(20);
    expect(pageOf(items, { limit: 500 }).items).toHaveLength(100);
    expect(pageOf(items, { limit: 100, page: 3 })).toEqual({ items: items.slice(200), next: null });
    expect(pageOf(items, { limit: 100, page: 2 }).next).toBe(3);
  });
});

describe('registration into agora.devTools', () => {
  function container(hub?: unknown) {
    return {
      hasBinding: (key: string) => key === 'agora.devTools' && hub !== undefined,
      make: async () => hub,
    };
  }
  const resolve = async () => new ResilienceService({ emit: false });

  it('skips without a hub', async () => {
    expect(await registerDevTools(container(), resolve)).toBe('no-hub');
  });

  it('skips a hub that cannot gate libs without a console', async () => {
    const register = vi.fn();
    expect(await registerDevTools(container({ version: 1, register }), resolve)).toBe(
      'unsupported',
    );
    expect(
      await registerDevTools(container({ version: 1, register, supports: () => false }), resolve),
    ).toBe('unsupported');
    expect(
      await registerDevTools(container({ version: 2, register, supports: () => true }), resolve),
    ).toBe('unsupported');
    expect(register).not.toHaveBeenCalled();
  });

  it('registers without its own authorize on a hub that supports endpoint-authorize', async () => {
    const libs: DevToolsLib[] = [];
    const hub: DevToolsHub = {
      version: 1,
      register: (lib) => libs.push(lib),
      supports: (capability) => capability === 'endpoint-authorize',
    };
    expect(await registerDevTools(container(hub), resolve)).toBe('registered');
    expect(libs).toHaveLength(1);
    expect(libs[0]?.lib).toBe('resilience');
    expect(libs[0]?.authorize).toBeUndefined();
  });

  it('never throws when the hub rejects the registration', async () => {
    const hub = {
      version: 1,
      supports: () => true,
      register: () => {
        throw new Error('duplicate');
      },
    };
    expect(await registerDevTools(container(hub), resolve)).toBe('failed');
  });
});
