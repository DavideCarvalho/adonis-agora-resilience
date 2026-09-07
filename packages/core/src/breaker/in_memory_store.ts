import { type Clock, systemClock } from '../clock.js';
import {
  type CircuitState,
  computeAdmit,
  computeRecord,
  INITIAL_CIRCUIT_STATE,
} from './state_machine.js';
import type { ResilienceStore } from './store.js';
import type { Admission, BreakerConfig, CircuitSnapshot, CircuitStatus } from './types.js';

export interface InMemoryResilienceStoreOptions {
  /**
   * Evict the least-recently-used entry once the store holds more than this many keys.
   * Recommended whenever `key` is derived from caller-influenced input (e.g. composed with a
   * tenant id per the tenant-scoping pattern) — without a bound, an attacker who can cause
   * arbitrarily many distinct keys to be admitted/recorded grows this map without limit.
   * Default: unbounded (matches prior behavior).
   */
  maxEntries?: number;
  /**
   * Treat an entry as expired — and recreate it fresh — once it hasn't been touched by
   * `admit`/`record`/`snapshot` for this many milliseconds. Checked lazily on next access to the
   * same key, not via a background timer, so it bounds re-use of stale state rather than
   * proactively freeing memory for keys that are never touched again (pair with `maxEntries` for
   * that). Default: entries never expire on their own (matches prior behavior).
   */
  ttlMs?: number;
}

interface StoredCircuit {
  state: CircuitState;
  touchedAt: number;
}

export class InMemoryResilienceStore implements ResilienceStore {
  private readonly map = new Map<string, StoredCircuit>();
  private readonly maxEntries: number | undefined;
  private readonly ttlMs: number | undefined;

  constructor(
    private readonly clock: Clock = systemClock,
    opts: InMemoryResilienceStoreOptions = {},
  ) {
    this.maxEntries = opts.maxEntries;
    this.ttlMs = opts.ttlMs;
  }

  /** Read (or lazily create) a key's state, refreshing its LRU position and expiring it first if
   *  it has gone stale past `ttlMs`. */
  private entry(key: string): CircuitState {
    const now = this.clock.now();
    const existing = this.map.get(key);
    if (existing) {
      const expired = this.ttlMs !== undefined && now - existing.touchedAt > this.ttlMs;
      this.map.delete(key);
      if (!expired) {
        existing.touchedAt = now;
        this.map.set(key, existing); // re-insert last = most-recently-used
        return existing.state;
      }
    }
    const state = { ...INITIAL_CIRCUIT_STATE };
    this.map.set(key, { state, touchedAt: now });
    this.evictIfNeeded();
    return state;
  }

  /** Write a key's state back, refreshing its LRU position and evicting the oldest entry/entries
   *  if that pushes the store past `maxEntries`. */
  private setState(key: string, state: CircuitState): void {
    this.map.delete(key);
    this.map.set(key, { state, touchedAt: this.clock.now() });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.maxEntries === undefined) return;
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  async admit(key: string, cfg: BreakerConfig): Promise<Admission> {
    const { state, admission } = computeAdmit(this.entry(key), cfg, this.clock.now());
    this.setState(key, state);
    return admission;
  }

  async record(
    key: string,
    cfg: BreakerConfig,
    ok: boolean,
    probe: boolean,
  ): Promise<CircuitStatus> {
    const { state, status } = computeRecord(this.entry(key), cfg, ok, probe, this.clock.now());
    this.setState(key, state);
    return status;
  }

  async snapshot(key: string): Promise<CircuitSnapshot> {
    const e = this.entry(key);
    return {
      status: e.status,
      failures: e.failures,
      ...(e.openUntil ? { openUntil: e.openUntil } : {}),
    };
  }

  async reset(key: string): Promise<void> {
    // Dropping the entry is equivalent to resetting to INITIAL_CIRCUIT_STATE — the next
    // entry(key) recreates it fresh.
    this.map.delete(key);
  }
}
