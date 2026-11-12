import type { StatefulKind } from '../events.js';

/** One key a stateful policy touched in this process. */
export interface KnownKey {
  kind: StatefulKind;
  key: string;
  /** The store instance holding the key's state. */
  store: unknown;
  /** The named policy that last touched it. */
  policy?: string;
  /** The policy's static config for the key (threshold, limit, …). */
  config?: Record<string, unknown>;
  /** Epoch ms of the last touch. */
  seenAt: number;
}

/**
 * A bounded, least-recently-used index of the keys stateful policies touched in this process, per
 * kind. It lets the service list circuits, bulkheads and rate limiters on stores that cannot
 * enumerate their own keys. Recording is O(1).
 */
export class KnownKeys {
  readonly #byKind = new Map<StatefulKind, Map<string, KnownKey>>();
  readonly #storeIds = new WeakMap<object, number>();
  #nextStoreId = 1;

  /** One index slot per (store, key): the same key on two stores is two entries. */
  #id(store: unknown, key: string): string {
    let id = 0;
    if ((typeof store === 'object' || typeof store === 'function') && store !== null) {
      id = this.#storeIds.get(store) ?? 0;
      if (id === 0) {
        id = this.#nextStoreId++;
        this.#storeIds.set(store, id);
      }
    }
    return `${id}\u0000${key}`;
  }

  constructor(readonly maxPerKind = 1000) {}

  record(entry: KnownKey): void {
    let map = this.#byKind.get(entry.kind);
    if (!map) {
      map = new Map();
      this.#byKind.set(entry.kind, map);
    }
    const id = this.#id(entry.store, entry.key);
    const previous = map.get(id);
    map.delete(id);
    map.set(id, {
      ...entry,
      ...(entry.policy === undefined && previous?.policy !== undefined
        ? { policy: previous.policy }
        : {}),
    });
    while (map.size > this.maxPerKind) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  get(kind: StatefulKind, key: string, store: unknown): KnownKey | undefined {
    return this.#byKind.get(kind)?.get(this.#id(store, key));
  }

  /** Every known key of `kind`, most recently touched first. */
  list(kind: StatefulKind): KnownKey[] {
    return [...(this.#byKind.get(kind)?.values() ?? [])].reverse();
  }

  size(kind: StatefulKind): number {
    return this.#byKind.get(kind)?.size ?? 0;
  }
}
