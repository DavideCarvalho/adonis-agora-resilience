import { describe, expect, it } from 'vitest';
import { type Clock, FakeClock } from '../clock.js';
import type { ResilienceStore } from './store.js';
import type { BreakerConfig } from './types.js';

const cfg: BreakerConfig = { threshold: 3, cooldownMs: 1000 };

/** Shared behavioural contract every ResilienceStore adapter must satisfy. */
export function runResilienceStoreContract(
  name: string,
  makeStore: (clock: Clock) => ResilienceStore,
): void {
  describe(`ResilienceStore contract: ${name}`, () => {
    it('opens after threshold and short-circuits', async () => {
      const s = makeStore(new FakeClock());
      for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
      expect((await s.admit('k', cfg)).allow).toBe(false);
    });

    it('hands exactly one probe to concurrent admits in half-open', async () => {
      const clock = new FakeClock();
      const s = makeStore(clock);
      for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
      clock.advance(1000);
      const admissions = await Promise.all(Array.from({ length: 10 }, () => s.admit('k', cfg)));
      expect(admissions.filter((a) => a.probe)).toHaveLength(1);
    });

    it('counts concurrent failures exactly (no lost updates)', async () => {
      // NOTE: This test proves serialized correctness under Node's run-to-completion model.
      // It does NOT prove interleaved atomicity for async adapters (Redis, DB, etc.).
      // Adapter authors MUST guarantee atomicity at the storage layer (e.g. via Lua scripts,
      // WATCH/MULTI/EXEC, or CAS) so that concurrent `record` calls never produce lost updates.
      const s = makeStore(new FakeClock());
      // 2 concurrent failures keep it closed (threshold 3), the 3rd opens it
      await Promise.all([s.record('k', cfg, false, false), s.record('k', cfg, false, false)]);
      expect((await s.snapshot('k')).failures).toBe(2);
      await s.record('k', cfg, false, false);
      expect((await s.snapshot('k')).status).toBe('open');
    });

    it('probe success closes fleet-wide; failure re-opens', async () => {
      const clock = new FakeClock();
      const s = makeStore(clock);
      for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
      clock.advance(1000);
      await s.admit('k', cfg);
      expect(await s.record('k', cfg, true, true)).toBe('closed');
    });

    it('probe failure re-opens the circuit', async () => {
      const clock = new FakeClock();
      const s = makeStore(clock);
      for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
      clock.advance(1000);
      await s.admit('k', cfg);
      expect(await s.record('k', cfg, false, true)).toBe('open');
      expect((await s.snapshot('k')).status).toBe('open');
    });

    it('reset clears an open circuit back to closed and admits again', async () => {
      const s = makeStore(new FakeClock());
      for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
      expect((await s.snapshot('k')).status).toBe('open');
      await s.reset('k');
      const snap = await s.snapshot('k');
      expect(snap.status).toBe('closed');
      expect(snap.failures).toBe(0);
      expect((await s.admit('k', cfg)).allow).toBe(true);
    });

    it('reset is a no-op on an unknown key', async () => {
      const s = makeStore(new FakeClock());
      await s.reset('never-seen');
      expect((await s.snapshot('never-seen')).status).toBe('closed');
    });
  });
}
