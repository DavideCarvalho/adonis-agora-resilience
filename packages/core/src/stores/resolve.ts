import { InMemoryResilienceStore } from '../breaker/in_memory_store.js';
import type { ResilienceStore } from '../breaker/store.js';
import { currentAmbient } from '../events.js';

let processStore: InMemoryResilienceStore | undefined;

/**
 * The process-wide in-memory store used by policies built outside `ResilienceService` without an
 * explicit store. Shared, so two policies with the same key see the same state.
 */
export function processMemoryStore(): InMemoryResilienceStore {
  processStore ??= new InMemoryResilienceStore(undefined, { maxEntries: 10_000 });
  return processStore;
}

/**
 * Resolve the store a policy uses, at build time: an instance as given; a name through the service
 * building the policy; nothing → the service's default store, or the process-wide memory store when
 * no service is building it.
 */
export function resolvePolicyStore(
  store: ResilienceStore | string | undefined,
  what: string,
): ResilienceStore {
  if (store !== undefined && typeof store !== 'string') return store;
  const resolve = currentAmbient().store;
  if (resolve) return resolve(store);
  if (typeof store === 'string') {
    throw new Error(
      `@adonis-agora/resilience: the ${what} names the store "${store}", which only works for a ` +
        'policy registered under `policies` in config/resilience.ts. Pass a store instance instead.',
    );
  }
  return processMemoryStore();
}
