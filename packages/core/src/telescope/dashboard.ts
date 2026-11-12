import type { Column, DashboardSpec } from './telescope-sdk.js';

/** Options for the "Resilience" telescope page. */
export interface ResilienceDashboardOptions {
  /** Show a Reset button on open and half-open circuits. Default true. */
  reset?: boolean;
}

/** The event types drawn on the "Events" chart. */
export const CHART_EVENTS = [
  'retry',
  'timeout',
  'short-circuited',
  'circuit-opened',
  'bulkhead-rejected',
  'rate-limited',
  'failover',
] as const;

/**
 * The "Resilience" page: what is broken now (circuits, bulkheads, rate limiters) and what happened in
 * the last hour (events recorded by telescope). Pure data: panels bind to the `resilience.*` data
 * providers by name.
 */
export function resilienceDashboard(opts: ResilienceDashboardOptions = {}): DashboardSpec {
  const circuitColumns: Column[] = [
    { key: 'key', label: 'Circuit' },
    { key: 'policy', label: 'Policy' },
    { key: 'status', label: 'Status' },
    { key: 'failures', label: 'Failures' },
    { key: 'until', label: 'Half-open at' },
    { key: 'store', label: 'Store' },
    { key: 'scope', label: 'Scope' },
  ];
  if (opts.reset !== false) {
    circuitColumns.push({
      key: 'reset',
      label: '',
      action: {
        name: 'resilience.reset-circuit',
        label: 'Reset',
        input: { key: '{key}', store: '{store}' },
        showWhen: { status: ['open', 'half-open'] },
      },
    });
  }
  const stat = (title: string, metric: string, warn: number, bad: number) =>
    ({
      kind: 'stat',
      title,
      data: { provider: 'resilience.stats', query: { metric } },
      thresholds: { warn, bad, direction: 'up-bad' },
    }) as const;
  return {
    id: 'resilience.overview',
    label: 'Resilience',
    navGroup: 'Libraries',
    panels: [],
    sections: [
      {
        title: 'Now',
        cols: 4,
        panels: [
          stat('Open circuits', 'open', 1, 3),
          stat('Half-open', 'half-open', 1, 3),
          stat('Short-circuited (1h)', 'short-circuited', 1, 100),
          stat('Retries (1h)', 'retry', 50, 500),
          stat('Timeouts (1h)', 'timeout', 10, 100),
          {
            kind: 'stat',
            title: 'Error rate (1h)',
            data: { provider: 'resilience.stats', query: { metric: 'error-rate' } },
            format: 'percent',
            thresholds: { warn: 0.02, bad: 0.1, direction: 'up-bad' },
          },
          stat('Bulkhead rejections (1h)', 'bulkhead-rejected', 1, 50),
          stat('Rate limited (1h)', 'rate-limited', 1, 50),
        ],
      },
      {
        title: 'Circuits',
        panels: [
          {
            kind: 'table',
            title: 'Circuits',
            data: { provider: 'resilience.circuits' },
            columns: circuitColumns,
            paged: true,
          },
        ],
      },
      {
        title: 'Limits',
        cols: 2,
        panels: [
          {
            kind: 'table',
            title: 'Bulkheads',
            data: { provider: 'resilience.bulkheads' },
            columns: [
              { key: 'key', label: 'Bulkhead' },
              { key: 'policy', label: 'Policy' },
              { key: 'active', label: 'Running' },
              { key: 'limit', label: 'Limit' },
              { key: 'store', label: 'Store' },
              { key: 'scope', label: 'Scope' },
            ],
          },
          {
            kind: 'table',
            title: 'Rate limiters',
            data: { provider: 'resilience.rate-limiters' },
            columns: [
              { key: 'key', label: 'Limiter' },
              { key: 'policy', label: 'Policy' },
              { key: 'remaining', label: 'Left' },
              { key: 'rate', label: 'Rate' },
              { key: 'store', label: 'Store' },
              { key: 'scope', label: 'Scope' },
            ],
          },
        ],
      },
      {
        title: 'Last hour',
        cols: 2,
        panels: [
          {
            kind: 'timeseries',
            title: 'Events',
            data: { provider: 'resilience.events-over-time' },
            series: [...CHART_EVENTS],
            style: 'stacked',
          },
          {
            kind: 'topN',
            title: 'Noisiest policies',
            data: { provider: 'resilience.noisy-policies' },
            limit: 8,
          },
        ],
      },
      {
        title: 'Transitions',
        panels: [
          {
            kind: 'table',
            title: 'Recent transitions',
            data: { provider: 'resilience.transitions' },
            columns: [
              { key: 'at', label: 'Time' },
              { key: 'event', label: 'Event', link: { href: '#/entries/{id}' } },
              { key: 'key', label: 'Circuit' },
              { key: 'policy', label: 'Policy' },
              { key: 'detail', label: 'Detail' },
            ],
          },
        ],
      },
    ],
  };
}
