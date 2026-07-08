import { type Clock, systemClock } from '../clock.js';
import {
  type CircuitState,
  INITIAL_CIRCUIT_STATE,
  computeAdmit,
  computeRecord,
} from './state_machine.js';
import type { ResilienceStore } from './store.js';
import type { Admission, BreakerConfig, CircuitSnapshot, CircuitStatus } from './types.js';

export class InMemoryResilienceStore implements ResilienceStore {
  private readonly map = new Map<string, CircuitState>();
  constructor(private readonly clock: Clock = systemClock) {}

  private entry(key: string): CircuitState {
    let e = this.map.get(key);
    if (!e) {
      e = { ...INITIAL_CIRCUIT_STATE };
      this.map.set(key, e);
    }
    return e;
  }

  async admit(key: string, cfg: BreakerConfig): Promise<Admission> {
    const { state, admission } = computeAdmit(this.entry(key), cfg, this.clock.now());
    this.map.set(key, state);
    return admission;
  }

  async record(
    key: string,
    cfg: BreakerConfig,
    ok: boolean,
    probe: boolean,
  ): Promise<CircuitStatus> {
    const { state, status } = computeRecord(this.entry(key), cfg, ok, probe, this.clock.now());
    this.map.set(key, state);
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
