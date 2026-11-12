import { randomUUID } from 'node:crypto';
import { type Clock, systemClock } from '../clock.js';
import { type BucketState, bucketTtlMs, consumeTokens } from '../limits/token_bucket.js';
import type {
  BulkheadAdmission,
  BulkheadConfig,
  BulkheadSnapshot,
  BulkheadStore,
  RateLimitConfig,
  RateLimitDecision,
  RateLimitSnapshot,
  RateLimitStore,
} from '../limits/types.js';
import {
  type CircuitState,
  computeAdmit,
  computeRecord,
  INITIAL_CIRCUIT_STATE,
} from './state_machine.js';
import type { KeysQuery, ResilienceStore } from './store.js';
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

/**
 * In-process store for circuits, bulkheads and rate limiters. State belongs to this process only:
 * every process of a fleet has its own circuits, its own bulkhead slots and its own rate budget.
 */
export class InMemoryResilienceStore implements ResilienceStore, BulkheadStore, RateLimitStore {
  private readonly map = new Map<string, StoredCircuit>();
  /**
   * Bulkhead key → lease id → expiry (epoch ms). A key is only here while one of its slots is held,
   * so its size is bounded by the calls in flight (no `maxEntries` eviction: that would free slots).
   */
  private readonly bulkheads = new Map<string, Map<string, number>>();
  private readonly releaseListeners = new Map<string, Set<() => void>>();
  /** Rate-limiter key → bucket, least recently used first; dropped once full again. */
  private readonly buckets = new Map<string, BucketState & { expiresAt: number }>();
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

  async keys(opts: KeysQuery): Promise<string[]> {
    const out: string[] = [];
    for (const key of this.map.keys()) {
      if (out.length >= opts.limit) break;
      if (opts.prefix === undefined || key.startsWith(opts.prefix)) out.push(key);
    }
    return out;
  }

  async reset(key: string): Promise<void> {
    // Dropping the entry is equivalent to resetting to INITIAL_CIRCUIT_STATE — the next
    // entry(key) recreates it fresh.
    this.map.delete(key);
  }

  // ── bulkheads ──────────────────────────────────────────────────────────────────────────────

  private liveLeases(key: string): Map<string, number> | undefined {
    const leases = this.bulkheads.get(key);
    if (!leases) return undefined;
    const now = this.clock.now();
    for (const [id, expiresAt] of leases) if (expiresAt <= now) leases.delete(id);
    if (leases.size === 0) {
      this.bulkheads.delete(key);
      return undefined;
    }
    return leases;
  }

  async acquireBulkhead(key: string, cfg: BulkheadConfig): Promise<BulkheadAdmission> {
    const leases = this.liveLeases(key) ?? new Map<string, number>();
    if (leases.size >= cfg.limit) return { acquired: false, active: leases.size };
    const leaseId = randomUUID();
    leases.set(leaseId, this.clock.now() + cfg.leaseMs);
    this.bulkheads.set(key, leases);
    return { acquired: true, leaseId, active: leases.size };
  }

  async releaseBulkhead(key: string, leaseId: string): Promise<void> {
    const leases = this.bulkheads.get(key);
    if (leases?.delete(leaseId) && leases.size === 0) this.bulkheads.delete(key);
    for (const listener of [...(this.releaseListeners.get(key) ?? [])]) listener();
  }

  async bulkheadSnapshot(key: string): Promise<BulkheadSnapshot> {
    return { active: this.liveLeases(key)?.size ?? 0 };
  }

  async resetBulkhead(key: string): Promise<void> {
    this.bulkheads.delete(key);
    for (const listener of [...(this.releaseListeners.get(key) ?? [])]) listener();
  }

  async bulkheadKeys(opts: KeysQuery): Promise<string[]> {
    const out: string[] = [];
    for (const key of [...this.bulkheads.keys()]) {
      if (out.length >= opts.limit) break;
      if (opts.prefix !== undefined && !key.startsWith(opts.prefix)) continue;
      if (this.liveLeases(key)) out.push(key);
    }
    return out;
  }

  onBulkheadRelease(key: string, listener: () => void): () => void {
    let set = this.releaseListeners.get(key);
    if (!set) {
      set = new Set();
      this.releaseListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.releaseListeners.delete(key);
    };
  }

  // ── rate limiters ──────────────────────────────────────────────────────────────────────────

  private bucket(key: string): BucketState | undefined {
    const stored = this.buckets.get(key);
    if (!stored) return undefined;
    if (stored.expiresAt <= this.clock.now()) {
      this.buckets.delete(key);
      return undefined;
    }
    return stored;
  }

  async consumeRateLimit(
    key: string,
    cfg: RateLimitConfig,
    cost: number,
  ): Promise<RateLimitDecision> {
    const now = this.clock.now();
    const { state, decision } = consumeTokens(this.bucket(key), cfg, cost, now);
    this.buckets.delete(key);
    this.buckets.set(key, { ...state, expiresAt: now + bucketTtlMs(cfg) });
    if (this.maxEntries !== undefined) {
      while (this.buckets.size > this.maxEntries) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
    return decision;
  }

  async rateLimitSnapshot(key: string): Promise<RateLimitSnapshot> {
    const state = this.bucket(key);
    const now = this.clock.now();
    return state ? { tokens: state.tokens, updatedAt: state.updatedAt, now } : { now };
  }

  async resetRateLimit(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  async rateLimitKeys(opts: KeysQuery): Promise<string[]> {
    const out: string[] = [];
    for (const key of [...this.buckets.keys()]) {
      if (out.length >= opts.limit) break;
      if (opts.prefix !== undefined && !key.startsWith(opts.prefix)) continue;
      if (this.bucket(key)) out.push(key);
    }
    return out;
  }
}
