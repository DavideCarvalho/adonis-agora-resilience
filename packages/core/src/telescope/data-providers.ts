import { offsetPage, parsePageParams } from '@adonis-agora/filter';
import { formatMs } from '../describe.js';
import { type CircuitInfo, ResilienceService } from '../resilience_service.js';
import { CHART_EVENTS } from './dashboard.js';
import type { DataProvider, ExtensionContext, TelescopeEntryLike } from './telescope-sdk.js';

const HOUR = 3_600_000;
const MAX_ENTRIES = 5_000;

/** A recorded `agora:resilience:*` diagnostic entry's content. */
interface ResilienceEntryContent {
  event?: string;
  payload?: {
    key?: string;
    policy?: string;
    ok?: boolean;
    [extra: string]: unknown;
  };
}

const contentOf = (e: TelescopeEntryLike): ResilienceEntryContent =>
  (e.content ?? {}) as ResilienceEntryContent;
const timeOf = (e: TelescopeEntryLike): number => (e.createdAt ? +new Date(e.createdAt) : 0);

function numberParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

/** Reads in flight per store and window: the page's panels resolve together and share one read. */
const inFlight = new WeakMap<object, Map<number, Promise<TelescopeEntryLike[]>>>();

/**
 * The `lib:resilience` diagnostic entries of the last `windowMs` (and the window before it, for
 * deltas), newest first. Shared storage makes this cluster-wide.
 */
export function resilienceEntries(
  ctx: ExtensionContext,
  windowMs: number,
  now = Date.now(),
): Promise<TelescopeEntryLike[]> {
  const store = ctx.store as object;
  let byWindow = inFlight.get(store);
  if (!byWindow) {
    byWindow = new Map();
    inFlight.set(store, byWindow);
  }
  const pending = byWindow.get(windowMs);
  if (pending) return pending;
  const read = ctx.store.list({
    type: 'diagnostic',
    tag: 'lib:resilience',
    after: new Date(now - 2 * windowMs),
    size: MAX_ENTRIES,
  });
  const map = byWindow;
  map.set(windowMs, read);
  const forget = () => {
    if (map.get(windowMs) === read) map.delete(windowMs);
  };
  read.then(forget, forget);
  return read;
}

function service(ctx: ExtensionContext): Promise<ResilienceService> {
  return ctx.container.make<ResilienceService>(ResilienceService);
}

function inWindow(entries: TelescopeEntryLike[], from: number, to: number) {
  return entries.filter((e) => {
    const at = timeOf(e);
    return at > from && at <= to;
  });
}

function countEvent(entries: TelescopeEntryLike[], event: string): number {
  let n = 0;
  for (const e of entries) if (contentOf(e).event === event) n += 1;
  return n;
}

function errorRate(entries: TelescopeEntryLike[]): number {
  let total = 0;
  let failed = 0;
  for (const e of entries) {
    const c = contentOf(e);
    if (c.event !== 'executed') continue;
    total += 1;
    if (c.payload?.ok === false) failed += 1;
  }
  return total === 0 ? 0 : failed / total;
}

/** `resilience.stats` — one number per `metric`, with the change against the previous window. */
export function resilienceStatsProvider(): DataProvider {
  return {
    name: 'resilience.stats',
    async resolve(query, ctx) {
      const metric = String(query?.metric ?? 'open');
      if (metric === 'open' || metric === 'half-open') {
        const circuits = await (await service(ctx)).circuits({ status: metric, first: 1000 });
        return { value: circuits.data.length };
      }
      const windowMs = numberParam(query?.windowMs, HOUR, 60_000, 7 * 24 * HOUR);
      const now = Date.now();
      const entries = await resilienceEntries(ctx, windowMs, now);
      const current = inWindow(entries, now - windowMs, now);
      const previous = inWindow(entries, now - 2 * windowMs, now - windowMs);
      if (metric === 'error-rate') {
        const value = errorRate(current);
        return { value, delta: value - errorRate(previous), deltaLabel: 'vs previous hour' };
      }
      const value = countEvent(current, metric);
      return { value, delta: value - countEvent(previous, metric), deltaLabel: 'vs previous hour' };
    },
  };
}

function circuitRow(c: CircuitInfo, now: number) {
  return {
    key: c.key,
    policy: c.policy ?? '',
    status: c.status,
    failures: c.failures,
    until:
      c.openUntil === undefined
        ? ''
        : c.openUntil > now
          ? `in ${formatMs(Math.ceil((c.openUntil - now) / 1000) * 1000)}`
          : new Date(c.openUntil).toISOString(),
    store: c.store,
    scope: c.scope,
    // Only circuits on a store the page can address get a Reset button.
    resettable: c.status !== 'closed' && c.store !== '(custom)' ? 'yes' : 'no',
  };
}

/**
 * `resilience.circuits` — the live circuits, as an offset page (`page` + `size`, answered with
 * `{ data, meta }`). On page 1, a first row warns when some circuits live in the memory store,
 * whose state is the telescope process's only.
 */
export function resilienceCircuitsProvider(): DataProvider {
  return {
    name: 'resilience.circuits',
    async resolve(query, ctx) {
      const { page, size } = parsePageParams(query ?? {}, { defaultSize: 25, maxSize: 200 });
      const { data: circuits } = await (await service(ctx)).circuits({ first: 1000 });
      const now = Date.now();
      const rows: Record<string, unknown>[] = circuits
        .slice((page - 1) * size, page * size)
        .map((c) => circuitRow(c, now));
      if (page === 1 && circuits.some((c) => c.scope === 'process')) {
        rows.unshift({
          key: 'memory store: this table shows the telescope process only',
          policy: '',
          status: '',
          failures: '',
          until: '',
          store: '',
          scope: '',
          resettable: 'no',
        });
      }
      return offsetPage(rows, { total: circuits.length, page, size });
    },
  };
}

/** `resilience.bulkheads` — live bulkheads, busiest first. */
export function resilienceBulkheadsProvider(): DataProvider {
  return {
    name: 'resilience.bulkheads',
    async resolve(_query, ctx) {
      const { data: bulkheads } = await (await service(ctx)).bulkheads({ first: 200 });
      return {
        rows: bulkheads.map((b) => ({
          key: b.key,
          policy: b.policy ?? '',
          active: b.active,
          limit: b.limit ?? '',
          store: b.store,
          scope: b.scope,
        })),
      };
    },
  };
}

/** `resilience.rate-limiters` — live rate limiters, emptiest first. */
export function resilienceRateLimitersProvider(): DataProvider {
  return {
    name: 'resilience.rate-limiters',
    async resolve(_query, ctx) {
      const { data: limiters } = await (await service(ctx)).rateLimiters({ first: 200 });
      return {
        rows: limiters.map((r) => ({
          key: r.key,
          policy: r.policy ?? '',
          remaining: r.remaining ?? (r.tokens !== undefined ? Math.floor(r.tokens) : ''),
          rate:
            r.limit !== undefined && r.intervalMs !== undefined
              ? `${r.limit}/${formatMs(r.intervalMs)}`
              : '',
          store: r.store,
          scope: r.scope,
        })),
      };
    },
  };
}

/** `resilience.events-over-time` — events per type in 12 buckets over the window (default 1h). */
export function resilienceEventsOverTimeProvider(): DataProvider {
  return {
    name: 'resilience.events-over-time',
    async resolve(query, ctx) {
      const windowMs = numberParam(query?.windowMs, HOUR, 60_000, 7 * 24 * HOUR);
      const buckets = numberParam(query?.buckets, 12, 2, 60);
      const now = Date.now();
      const start = now - windowMs;
      const step = windowMs / buckets;
      const rows = Array.from({ length: buckets }, (_, i) => {
        const row: { label: string } & Record<string, number | string> = {
          label: new Date(start + (i + 1) * step).toISOString().slice(11, 16),
        };
        for (const type of CHART_EVENTS) row[type] = 0;
        return row;
      });
      const tracked = new Set<string>(CHART_EVENTS);
      for (const e of inWindow(await resilienceEntries(ctx, windowMs, now), start, now)) {
        const event = contentOf(e).event;
        if (!event || !tracked.has(event)) continue;
        const index = Math.min(buckets - 1, Math.floor((timeOf(e) - start) / step));
        const row = rows[index];
        if (row) row[event] = (row[event] as number) + 1;
      }
      return { rows };
    },
  };
}

const NOISE = new Set(['retry', 'timeout', 'short-circuited', 'bulkhead-rejected', 'rate-limited']);

/** `resilience.noisy-policies` — policies with the most retries, timeouts and rejections. */
export function resilienceNoisyPoliciesProvider(): DataProvider {
  return {
    name: 'resilience.noisy-policies',
    async resolve(query, ctx) {
      const windowMs = numberParam(query?.windowMs, HOUR, 60_000, 7 * 24 * HOUR);
      const now = Date.now();
      const counts = new Map<string, number>();
      for (const e of inWindow(await resilienceEntries(ctx, windowMs, now), now - windowMs, now)) {
        const c = contentOf(e);
        if (!c.event || !NOISE.has(c.event)) continue;
        const label = c.payload?.policy ?? (c.payload?.key ? `(key) ${c.payload.key}` : '(inline)');
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return {
        items: [...counts]
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
      };
    },
  };
}

const TRANSITIONS = new Set([
  'circuit-opened',
  'circuit-half-open',
  'circuit-closed',
  'circuit-reset',
]);

/** `resilience.transitions` — the latest circuit state changes and resets, newest first (`first`, default 50). */
export function resilienceTransitionsProvider(): DataProvider {
  return {
    name: 'resilience.transitions',
    async resolve(query, ctx) {
      const windowMs = numberParam(query?.windowMs, 24 * HOUR, 60_000, 7 * 24 * HOUR);
      const limit = numberParam(query?.first, 50, 1, 500);
      const rows: Record<string, unknown>[] = [];
      const entries = [...(await resilienceEntries(ctx, windowMs))].sort(
        (a, b) => timeOf(b) - timeOf(a),
      );
      for (const e of entries) {
        const c = contentOf(e);
        if (!c.event || !TRANSITIONS.has(c.event)) continue;
        const p = c.payload ?? {};
        rows.push({
          id: e.id ?? '',
          at: e.createdAt ? new Date(e.createdAt).toISOString() : '',
          event: c.event,
          key: p.key ?? '',
          policy: p.policy ?? '',
          detail:
            c.event === 'circuit-reset'
              ? `by ${String(p.by ?? 'unknown')}${p.via ? ` via ${String(p.via)}` : ''}`
              : '',
        });
        if (rows.length >= limit) break;
      }
      return { rows };
    },
  };
}

/** Every data provider the Resilience page binds to. */
export function resilienceDataProviders(): DataProvider[] {
  return [
    resilienceStatsProvider(),
    resilienceCircuitsProvider(),
    resilienceBulkheadsProvider(),
    resilienceRateLimitersProvider(),
    resilienceEventsOverTimeProvider(),
    resilienceNoisyPoliciesProvider(),
    resilienceTransitionsProvider(),
  ];
}
