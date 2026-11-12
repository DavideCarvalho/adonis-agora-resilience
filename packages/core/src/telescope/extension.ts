import { ResilienceService } from '../resilience_service.js';
import { type ResilienceDashboardOptions, resilienceDashboard } from './dashboard.js';
import { resilienceDataProviders } from './data-providers.js';
import type { ExtensionAction, TelescopeExtension } from './telescope-sdk.js';

/** Options for {@link resilienceTelescopeExtension}. */
export interface ResilienceTelescopeOptions extends ResilienceDashboardOptions {}

/**
 * `resilience.reset-circuit`: force a circuit back to closed from the telescope page. Runs behind
 * the telescope console's `authorize`, after confirmation; logs an audit line and emits
 * `circuit-reset` with the acting user.
 */
export function resetCircuitAction(): ExtensionAction {
  return {
    name: 'resilience.reset-circuit',
    label: 'Reset',
    confirm:
      'Reset circuit "{key}" ({store})? It closes now and calls go through to the dependency again.',
    destructive: true,
    async run(input, ctx) {
      const key = typeof input.key === 'string' ? input.key.trim() : '';
      if (key === '') throw new Error('resilience.reset-circuit needs a circuit `key`');
      const resilience = await ctx.container.make<ResilienceService>(ResilienceService);
      const store = typeof input.store === 'string' ? input.store : undefined;
      const named =
        store !== undefined && resilience.storeNames().includes(store) ? store : undefined;
      if (store !== undefined && named === undefined && store !== '(default)') {
        throw new Error(`Unknown resilience store "${store}".`);
      }
      return resilience.resetCircuit(key, {
        ...(named !== undefined ? { store: named } : {}),
        by: ctx.actor ?? 'telescope',
        via: 'telescope',
      });
    },
  };
}

/**
 * The `@adonis-agora/telescope` extension for resilience: a "Resilience" page (circuits, bulkheads,
 * rate limiters, the last hour of events) plus the data providers and the circuit-reset action it
 * uses. The provider adds it to telescope on its own; add it by hand only when you turned that off:
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/telescope'
 * import { resilienceTelescopeExtension } from '@adonis-agora/resilience/telescope'
 *
 * export default defineConfig({ extensions: [resilienceTelescopeExtension()] })
 * ```
 */
export function resilienceTelescopeExtension(
  opts: ResilienceTelescopeOptions = {},
): TelescopeExtension {
  return {
    name: 'resilience',
    dashboards: () => [resilienceDashboard(opts)],
    dataProviders: () => resilienceDataProviders(),
    actions: () => (opts.reset === false ? [] : [resetCircuitAction()]),
  };
}
