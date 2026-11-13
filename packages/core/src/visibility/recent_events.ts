import {
  type CursorPageResponse,
  cursorPage,
  decodeCursor,
  encodeCursor,
} from '@adonis-agora/filter';
import type { ResilienceEvent, ResilienceEventType } from '../events.js';

/** A resilience event as kept in the recent-events buffer: sanitized, with the time it happened. */
export type RecentEvent = ResilienceEvent & { at: number };

/**
 * Filters and paging for {@link RecentEvents.list}, newest first. Page forward (older events) with
 * `after` = the previous page's `meta.nextCursor` and `first`; backward (newer events) with
 * `before` = `meta.prevCursor` and `last`. `after` wins when both are given.
 */
export interface RecentEventsQuery {
  type?: ResilienceEventType | ResilienceEventType[];
  key?: string;
  policy?: string;
  /** Page size going forward. Default 20, at most the buffer's capacity. */
  first?: number;
  /** Page size going backward (with `before`). Default 20, at most the buffer's capacity. */
  last?: number;
  /** Older events than this cursor. */
  after?: string;
  /** Newer events than this cursor. */
  before?: string;
}

/** Thrown for a cursor this buffer did not produce. */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor.');
    this.name = 'InvalidCursorError';
  }
}

const DEFAULT_SIZE = 20;

function seqOf(cursor: string): number {
  const values = decodeCursor(cursor);
  const seq = values?.[0];
  if (values?.length !== 1 || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new InvalidCursorError();
  }
  return seq;
}

/**
 * A fixed-size ring of the most recent resilience events in this process. Writing is O(1) and
 * allocation-free once full; reading copies newest-first, one cursor page at a time.
 *
 * Every event gets a sequence number; a cursor is that number, so paging stays stable while new
 * events arrive. Events that fall out of the ring are simply no longer listed.
 */
export class RecentEvents {
  readonly #items: (RecentEvent | undefined)[];
  readonly #seqs: number[];
  #next = 0;
  #count = 0;
  #seq = 0;

  constructor(readonly capacity = 200) {
    this.#items = new Array(capacity);
    this.#seqs = new Array(capacity).fill(0);
  }

  push(event: RecentEvent): void {
    this.#items[this.#next] = event;
    this.#seqs[this.#next] = ++this.#seq;
    this.#next = (this.#next + 1) % this.capacity;
    if (this.#count < this.capacity) this.#count += 1;
  }

  get size(): number {
    return this.#count;
  }

  list(query: RecentEventsQuery = {}): CursorPageResponse<RecentEvent> {
    const types =
      query.type === undefined
        ? undefined
        : new Set(Array.isArray(query.type) ? query.type : [query.type]);
    // Matching events, newest first, with their sequence numbers.
    const matching: Array<{ seq: number; event: RecentEvent }> = [];
    for (let i = 1; i <= this.#count; i++) {
      const slot = (this.#next - i + this.capacity) % this.capacity;
      const event = this.#items[slot];
      if (!event) continue;
      if (types && !types.has(event.type)) continue;
      if (query.key !== undefined && event.key !== query.key) continue;
      if (query.policy !== undefined && event.policy !== query.policy) continue;
      matching.push({ seq: this.#seqs[slot] as number, event });
    }

    const backward = query.after === undefined && query.before !== undefined;
    const requested = backward ? (query.last ?? query.first) : (query.first ?? query.last);
    const size = Math.min(
      this.capacity,
      Math.max(1, Number.isFinite(requested) ? Math.floor(requested as number) : DEFAULT_SIZE),
    );

    let start: number;
    let end: number;
    if (query.after !== undefined) {
      const after = seqOf(query.after);
      start = matching.findIndex((m) => m.seq < after);
      if (start === -1) start = matching.length;
      end = Math.min(matching.length, start + size);
    } else if (query.before !== undefined) {
      const before = seqOf(query.before);
      end = matching.findIndex((m) => m.seq <= before);
      if (end === -1) end = matching.length;
      start = Math.max(0, end - size);
    } else {
      start = 0;
      end = Math.min(matching.length, size);
    }

    const page = matching.slice(start, end);
    const first = page[0];
    const last = page[page.length - 1];
    const hasPrev = start > 0;
    const hasNext = end < matching.length;
    return cursorPage(
      page.map((m) => m.event),
      {
        // An empty page past either end still points back at where it started.
        nextCursor: hasNext ? (last ? encodeCursor([last.seq]) : (query.before ?? null)) : null,
        prevCursor: hasPrev ? (first ? encodeCursor([first.seq]) : (query.after ?? null)) : null,
        hasNext,
        hasPrev,
      },
    );
  }
}
