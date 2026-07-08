import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock';
import { InMemoryResilienceStore } from './in_memory_store';
import type { BreakerConfig } from './types';

const cfg: BreakerConfig = { threshold: 3, cooldownMs: 1000 };

describe('InMemoryResilienceStore', () => {
  it('starts closed and admits', async () => {
    const s = new InMemoryResilienceStore(new FakeClock());
    expect(await s.admit('k', cfg)).toEqual({ allow: true, probe: false, status: 'closed' });
  });

  it('opens after `threshold` failures and then short-circuits', async () => {
    const clock = new FakeClock();
    const s = new InMemoryResilienceStore(clock);
    await s.record('k', cfg, false, false);
    await s.record('k', cfg, false, false);
    expect(await s.record('k', cfg, false, false)).toBe('open');
    const a = await s.admit('k', cfg);
    expect(a.allow).toBe(false);
    expect((await s.snapshot('k')).status).toBe('open');
  });

  it('a success resets the failure count', async () => {
    const s = new InMemoryResilienceStore(new FakeClock());
    await s.record('k', cfg, false, false);
    await s.record('k', cfg, true, false);
    expect((await s.snapshot('k')).failures).toBe(0);
  });

  it('after cooldown, admit hands exactly one caller the probe', async () => {
    const clock = new FakeClock();
    const s = new InMemoryResilienceStore(clock);
    for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
    clock.advance(1000);
    const a1 = await s.admit('k', cfg);
    const a2 = await s.admit('k', cfg);
    expect([a1.probe, a2.probe].filter(Boolean)).toHaveLength(1);
    expect(a1.status).toBe('half-open');
  });

  it('probe success closes; probe failure re-opens', async () => {
    const clock = new FakeClock();
    const s = new InMemoryResilienceStore(clock);
    for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
    clock.advance(1000);
    await s.admit('k', cfg); // claim the probe
    expect(await s.record('k', cfg, true, true)).toBe('closed');

    for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
    clock.advance(1000);
    await s.admit('k', cfg);
    expect(await s.record('k', cfg, false, true)).toBe('open');
  });
});
