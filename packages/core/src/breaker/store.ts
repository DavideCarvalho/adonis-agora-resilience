import type { Admission, BreakerConfig, CircuitSnapshot, CircuitStatus } from './types.js';

/**
 * Pluggable storage interface for circuit-breaker state.
 *
 * **Atomicity contract (MUST be honoured by all implementations):**
 * Both `admit` and `record` must execute as atomic operations — no lost updates,
 * no double-counted failures, and exactly one half-open probe granted under concurrent calls.
 * The built-in `InMemoryResilienceStore` satisfies this for free via JavaScript's
 * single-threaded run-to-completion model. Distributed adapters (Redis, database-backed,
 * etc.) MUST enforce atomicity explicitly — for example via Lua scripts, WATCH/MULTI/EXEC
 * transactions, or compare-and-swap (CAS) primitives — to avoid race conditions that would
 * cause incorrect circuit state.
 */
export interface ResilienceStore {
  /** Decide whether a call may proceed; atomically flip open→half-open after cooldown and hand the
   *  probe slot to one caller. */
  admit(key: string, cfg: BreakerConfig): Promise<Admission>;
  /** Record an outcome; atomically update counters/state and return the resulting status. */
  record(key: string, cfg: BreakerConfig, ok: boolean, probe: boolean): Promise<CircuitStatus>;
  /** Read-only snapshot. */
  snapshot(key: string): Promise<CircuitSnapshot>;
  /**
   * Clear a circuit back to its initial closed state (failures 0, no cooldown). The next `admit`
   * starts from a clean slate, exactly as if the key had never been seen. Idempotent — resetting an
   * unknown key is a no-op.
   */
  reset(key: string): Promise<void>;
  /**
   * OPTIONAL: list the circuit keys this store holds, for dashboards and tooling. Stores that cannot
   * enumerate cheaply leave it out; the service then lists the keys it saw in this process.
   */
  keys?(opts: KeysQuery): Promise<string[]>;
}

/** Input of the optional `keys()` store methods. */
export interface KeysQuery {
  /** Only keys starting with this prefix. */
  prefix?: string;
  /** Upper bound on how many keys come back. */
  limit: number;
}
