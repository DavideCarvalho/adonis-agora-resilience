import type { ResilienceEvent, ResilienceEventType } from '../events.js';

/** A resilience event as kept in the recent-events buffer: sanitized, with the time it happened. */
export type RecentEvent = ResilienceEvent & { at: number };

/** Filters for {@link RecentEvents.list}. */
export interface RecentEventsQuery {
  type?: ResilienceEventType | ResilienceEventType[];
  key?: string;
  policy?: string;
  /** Default 20. */
  limit?: number;
}

/**
 * A fixed-size ring of the most recent resilience events in this process. Writing is O(1) and
 * allocation-free once full; reading copies newest-first.
 */
export class RecentEvents {
  readonly #items: (RecentEvent | undefined)[];
  #next = 0;
  #count = 0;

  constructor(readonly capacity = 200) {
    this.#items = new Array(capacity);
  }

  push(event: RecentEvent): void {
    this.#items[this.#next] = event;
    this.#next = (this.#next + 1) % this.capacity;
    if (this.#count < this.capacity) this.#count += 1;
  }

  get size(): number {
    return this.#count;
  }

  list(query: RecentEventsQuery = {}): RecentEvent[] {
    const limit = Math.max(0, query.limit ?? 20);
    const types =
      query.type === undefined
        ? undefined
        : new Set(Array.isArray(query.type) ? query.type : [query.type]);
    const out: RecentEvent[] = [];
    for (let i = 1; i <= this.#count && out.length < limit; i++) {
      const event = this.#items[(this.#next - i + this.capacity) % this.capacity];
      if (!event) continue;
      if (types && !types.has(event.type)) continue;
      if (query.key !== undefined && event.key !== query.key) continue;
      if (query.policy !== undefined && event.policy !== query.policy) continue;
      out.push(event);
    }
    return out;
  }
}
