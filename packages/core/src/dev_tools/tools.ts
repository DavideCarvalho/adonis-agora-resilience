import type { CircuitStatus } from '../breaker/types.js';
import type { ResilienceEventType } from '../events.js';
import type { ResilienceService } from '../resilience_service.js';
import type { DevTool, DevToolInputProperty, DevToolsHub } from './contract.js';
import { DEV_TOOLS_BINDING } from './contract.js';

const STATUSES: readonly CircuitStatus[] = ['closed', 'open', 'half-open'];
const EVENT_TYPES: readonly ResilienceEventType[] = [
  'circuit-opened',
  'circuit-closed',
  'circuit-half-open',
  'circuit-reset',
  'short-circuited',
  'failover',
  'timeout',
  'retry',
  'executed',
  'bulkhead-rejected',
  'rate-limited',
];

const limit: DevToolInputProperty = {
  type: 'integer',
  description: 'How many items to return (default 20, max 100).',
  minimum: 1,
  maximum: 100,
};
const page: DevToolInputProperty = {
  type: 'integer',
  description: 'Page number, from 1 (the `next` of the previous answer).',
  minimum: 1,
};
const store: DevToolInputProperty = {
  type: 'string',
  description:
    'A store name from config/resilience.ts. Default: every store (lists) or the default one.',
};
const prefix: DevToolInputProperty = {
  type: 'string',
  description: 'Only keys starting with this.',
};

function intOf(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.floor(value)))
    : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The required circuit `key`, trimmed; throws on a missing or empty one. */
function requiredKey(input: Record<string, unknown>): string {
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  if (key === '') throw new Error('`key` is required: the circuit key');
  return key;
}

/** One page of `items` in the `{ items, next }` shape every dev-tools list returns. */
export function pageOf<T>(items: readonly T[], input: Record<string, unknown>) {
  const size = intOf(input.limit, 20, 100);
  const number = intOf(input.page, 1);
  const start = (number - 1) * size;
  return {
    items: items.slice(start, start + size),
    next: start + size < items.length ? number + 1 : null,
  };
}

/**
 * The resilience developer tools: read tools for policies, circuits, bulkheads, rate limiters and
 * recent events, and one action (`resilience_reset_circuit`). `resolve` returns the service at call
 * time.
 */
export function resilienceDevTools(resolve: () => Promise<ResilienceService>): DevTool[] {
  return [
    {
      name: 'resilience_list_policies',
      kind: 'read',
      description:
        'The named resilience policies from config/resilience.ts and what each is made of ' +
        "(e.g. ['timeout(2s)', 'retry(3, exp 200ms)', 'circuit-breaker(key=stripe, threshold=5, cooldown=30s)']). " +
        'A policy whose factory throws has `error`. Returns { items, next }.',
      input: { type: 'object', properties: { limit, page } },
      async run(input) {
        return pageOf((await resolve()).describePolicies(), input);
      },
    },
    {
      name: 'resilience_list_circuits',
      kind: 'read',
      description:
        'Circuit breakers with their live state: key, store, policy, status (open first), failures, ' +
        "openUntil (epoch ms), scope ('process' = in-memory store, this process only; 'cluster' = shared). " +
        'Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: STATUSES, description: 'Only circuits in this state.' },
          store,
          prefix,
          limit,
          page,
        },
      },
      async run(input) {
        const status = str(input.status) as CircuitStatus | undefined;
        const circuits = await (await resolve()).circuits({
          ...(status ? { status } : {}),
          ...(str(input.store) ? { store: str(input.store) as string } : {}),
          ...(str(input.prefix) ? { prefix: str(input.prefix) as string } : {}),
          limit: 1000,
        });
        return pageOf(circuits, input);
      },
    },
    {
      name: 'resilience_get_circuit',
      kind: 'read',
      description:
        'One circuit breaker by key: its live state plus the last 10 events for that key seen by this process.',
      input: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The circuit key.' }, store },
        required: ['key'],
      },
      async run(input) {
        const key = requiredKey(input);
        const service = await resolve();
        return {
          circuit: await service.getCircuit(key, str(input.store)),
          recentEvents: service.recentEvents({ key, limit: 10 }),
        };
      },
    },
    {
      name: 'resilience_list_bulkheads',
      kind: 'read',
      description:
        'Bulkheads (concurrency limits) with the calls running now, their limit, policy, store and scope. ' +
        'Busiest first. Returns { items, next }.',
      input: { type: 'object', properties: { store, prefix, limit, page } },
      async run(input) {
        const items = await (await resolve()).bulkheads({
          ...(str(input.store) ? { store: str(input.store) as string } : {}),
          ...(str(input.prefix) ? { prefix: str(input.prefix) as string } : {}),
          limit: 1000,
        });
        return pageOf(items, input);
      },
    },
    {
      name: 'resilience_list_rate_limiters',
      kind: 'read',
      description:
        'Rate limiters with the budget left (remaining), limit per intervalMs, policy, store and scope. ' +
        'Emptiest first. Returns { items, next }.',
      input: { type: 'object', properties: { store, prefix, limit, page } },
      async run(input) {
        const items = await (await resolve()).rateLimiters({
          ...(str(input.store) ? { store: str(input.store) as string } : {}),
          ...(str(input.prefix) ? { prefix: str(input.prefix) as string } : {}),
          limit: 1000,
        });
        return pageOf(items, input);
      },
    },
    {
      name: 'resilience_list_recent_events',
      kind: 'read',
      description:
        'The most recent resilience events seen by THIS process only (the last 200 kept), newest first: ' +
        'retries, timeouts, circuit transitions, rejections. Errors are reduced to { name, message }. ' +
        'Returns { items, next: null, scope: "this process" }.',
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: EVENT_TYPES, description: 'Only this event type.' },
          key: { type: 'string', description: 'Only events for this key.' },
          policy: { type: 'string', description: 'Only events of this named policy.' },
          limit,
        },
      },
      async run(input) {
        const type = str(input.type) as ResilienceEventType | undefined;
        const items = (await resolve()).recentEvents({
          ...(type ? { type } : {}),
          ...(str(input.key) ? { key: str(input.key) as string } : {}),
          ...(str(input.policy) ? { policy: str(input.policy) as string } : {}),
          limit: intOf(input.limit, 20, 100),
        });
        return { items, next: null, scope: 'this process' };
      },
    },
    {
      name: 'resilience_reset_circuit',
      kind: 'action',
      destructive: true,
      description:
        'Force a circuit breaker back to closed so calls reach the dependency again. Writes an audit ' +
        'log line and a circuit-reset event naming the caller. Returns the circuit after the reset.',
      input: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The circuit key.' }, store },
        required: ['key'],
      },
      async run(input, call) {
        const key = requiredKey(input);
        const named = str(input.store);
        return (await resolve()).resetCircuit(key, {
          ...(named ? { store: named } : {}),
          by: call.caller.id,
          via: 'mcp',
        });
      },
    },
  ];
}

/** The slice of the AdonisJS container {@link registerDevTools} uses. */
export interface DevToolsContainer {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

/**
 * Register the resilience tools into the dev-tools hub, when the agent's MCP provider bound one and it
 * can gate a lib without a console (`supports('endpoint-authorize')`). Never throws: returns why it
 * did not register.
 */
export async function registerDevTools(
  container: DevToolsContainer,
  resolve: () => Promise<ResilienceService>,
): Promise<'registered' | 'no-hub' | 'unsupported' | 'failed'> {
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return 'no-hub';
  try {
    const hub = (await container.make(DEV_TOOLS_BINDING)) as DevToolsHub | undefined;
    if (hub?.version !== 1) return 'unsupported';
    if (typeof hub.supports !== 'function' || !hub.supports('endpoint-authorize')) {
      return 'unsupported';
    }
    hub.register({ lib: 'resilience', title: 'Resilience', tools: resilienceDevTools(resolve) });
    return 'registered';
  } catch {
    return 'failed';
  }
}
