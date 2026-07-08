import { describe, expect, it } from 'vitest';
import {
  type CircuitState,
  INITIAL_CIRCUIT_STATE,
  computeAdmit,
  computeRecord,
} from './state_machine';
import type { BreakerConfig } from './types';

const cfg: BreakerConfig = { threshold: 3, cooldownMs: 1000 };
const fresh = (): CircuitState => ({ ...INITIAL_CIRCUIT_STATE });

describe('computeRecord', () => {
  it('opens after threshold consecutive failures', () => {
    let s = fresh();
    for (let i = 0; i < 2; i++) s = computeRecord(s, cfg, false, false, 0).state;
    expect(s.failures).toBe(2);
    const r = computeRecord(s, cfg, false, false, 0);
    expect(r.status).toBe('open');
    expect(r.state.openUntil).toBe(1000);
  });

  it('success resets to closed', () => {
    const opened = computeRecord(
      { status: 'open', failures: 3, openUntil: 1000, probes: 0 },
      cfg,
      true,
      false,
      0,
    );
    expect(opened.status).toBe('closed');
    expect(opened.state).toEqual({ status: 'closed', failures: 0, openUntil: 0, probes: 0 });
  });

  it('probe failure re-opens', () => {
    const r = computeRecord(
      { status: 'half-open', failures: 3, openUntil: 0, probes: 1 },
      cfg,
      false,
      true,
      500,
    );
    expect(r.status).toBe('open');
    expect(r.state.openUntil).toBe(1500);
    expect(r.state.probes).toBe(0);
  });
});

describe('computeAdmit', () => {
  it('closed allows without a probe', () => {
    expect(computeAdmit(fresh(), cfg, 0).admission).toEqual({
      allow: true,
      probe: false,
      status: 'closed',
    });
  });

  it('open denies before cooldown', () => {
    const a = computeAdmit({ status: 'open', failures: 3, openUntil: 1000, probes: 0 }, cfg, 500);
    expect(a.admission).toEqual({ allow: false, probe: false, status: 'open' });
  });

  it('open past cooldown grants exactly one probe; the next admit is denied', () => {
    const open: CircuitState = { status: 'open', failures: 3, openUntil: 1000, probes: 0 };
    const first = computeAdmit(open, cfg, 1000);
    expect(first.admission).toEqual({ allow: true, probe: true, status: 'half-open' });
    const second = computeAdmit(first.state, cfg, 1000);
    expect(second.admission).toEqual({ allow: false, probe: false, status: 'half-open' });
  });
});
