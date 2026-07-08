import type { Admission, BreakerConfig, CircuitStatus } from './types.js';

/**
 * The pure circuit-breaker state machine — the single source of truth for admit/record semantics,
 * shared by the in-memory and SQL stores (which call {@link computeAdmit} / {@link computeRecord}
 * directly inside their own atomic cycle).
 *
 * ⚠️ The Redis store CANNOT call these — it reimplements the same branching in Lua so the whole
 * cycle runs atomically on the server (see `stores/redis_lua.ts`). Any change
 * to the transitions here MUST be mirrored in those scripts, or a Redis-backed circuit will diverge
 * from the others. The shared `runResilienceStoreContract` is the guard that catches such drift.
 */

/** Plain, serializable circuit state — the unit every store persists. */
export interface CircuitState {
  status: CircuitStatus;
  failures: number;
  openUntil: number;
  probes: number;
}

/** Fresh-circuit defaults (a brand-new key behaves as a closed circuit). */
export const INITIAL_CIRCUIT_STATE: CircuitState = {
  status: 'closed',
  failures: 0,
  openUntil: 0,
  probes: 0,
};

/**
 * Pure admit decision. Given the previous state, the breaker config, and the caller's clock time,
 * returns the next state and the admission. No I/O — stores call this inside their own atomic
 * load→compute→persist cycle.
 */
export function computeAdmit(
  prev: CircuitState,
  cfg: BreakerConfig,
  now: number,
): { state: CircuitState; admission: Admission } {
  let { status, probes } = prev;
  const { failures, openUntil } = prev;
  if (status === 'open' && now >= openUntil) {
    status = 'half-open';
    probes = 0;
  }
  if (status === 'closed') {
    return {
      state: { status, failures, openUntil, probes },
      admission: { allow: true, probe: false, status: 'closed' },
    };
  }
  if (status === 'open') {
    return {
      state: { status, failures, openUntil, probes },
      admission: { allow: false, probe: false, status: 'open' },
    };
  }
  const max = cfg.halfOpenMax ?? 1;
  if (probes < max) {
    probes += 1;
    return {
      state: { status, failures, openUntil, probes },
      admission: { allow: true, probe: true, status: 'half-open' },
    };
  }
  return {
    state: { status, failures, openUntil, probes },
    admission: { allow: false, probe: false, status: 'half-open' },
  };
}

/**
 * Pure record of an outcome. Returns the next state and the resulting status.
 */
export function computeRecord(
  prev: CircuitState,
  cfg: BreakerConfig,
  ok: boolean,
  probe: boolean,
  now: number,
): { state: CircuitState; status: CircuitStatus } {
  let { status, failures, openUntil, probes } = prev;
  if (probe) probes = Math.max(0, probes - 1);
  if (ok) {
    return { state: { status: 'closed', failures: 0, openUntil: 0, probes }, status: 'closed' };
  }
  if (probe || status === 'half-open') {
    status = 'open';
    openUntil = now + cfg.cooldownMs;
    return { state: { status, failures, openUntil, probes }, status: 'open' };
  }
  failures += 1;
  if (failures >= cfg.threshold) {
    status = 'open';
    openUntil = now + cfg.cooldownMs;
    return { state: { status, failures, openUntil, probes }, status: 'open' };
  }
  return { state: { status, failures, openUntil, probes }, status };
}
