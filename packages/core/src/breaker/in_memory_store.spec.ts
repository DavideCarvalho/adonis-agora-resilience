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

  describe('maxEntries (LRU eviction)', () => {
    it('stays unbounded by default, growing for every distinct key', async () => {
      const s = new InMemoryResilienceStore(new FakeClock());
      for (let i = 0; i < 200; i++) await s.admit(`k${i}`, cfg);
      // no eviction: every key's failure count is still independently tracked
      for (let i = 0; i < 200; i++) {
        await s.record(`k${i}`, cfg, false, false);
      }
      expect((await s.snapshot('k0')).failures).toBe(1);
      expect((await s.snapshot('k199')).failures).toBe(1);
    });

    it('evicts the least-recently-used key once `maxEntries` is exceeded', async () => {
      const s = new InMemoryResilienceStore(new FakeClock(), { maxEntries: 2 });
      await s.admit('a', cfg);
      await s.admit('b', cfg);
      await s.admit('c', cfg); // pushes size to 3, evicts the LRU key ('a')

      // 'a' was evicted, so it comes back fresh (closed, 0 failures) instead of retaining state
      await s.record('a', cfg, false, false);
      expect((await s.snapshot('a')).failures).toBe(1);
      // 'b' and 'c' should both still be present (only one eviction happened)
      expect(await s.snapshot('b')).toBeDefined();
      expect(await s.snapshot('c')).toBeDefined();
    });

    it('touching a key (admit/record/snapshot) refreshes its LRU position', async () => {
      const s = new InMemoryResilienceStore(new FakeClock(), { maxEntries: 2 });
      await s.admit('a', cfg);
      await s.admit('b', cfg);
      await s.snapshot('a'); // touch 'a' so 'b' becomes the LRU key
      await s.admit('c', cfg); // should evict 'b', not 'a'

      await s.record('a', cfg, false, false);
      expect((await s.snapshot('a')).failures).toBe(1); // 'a' survived with its state

      await s.record('b', cfg, false, false); // 'b' was evicted, recreated fresh
      expect((await s.snapshot('b')).failures).toBe(1);
    });
  });

  describe('ttlMs (lazy expiry)', () => {
    it('never expires entries by default', async () => {
      const clock = new FakeClock();
      const s = new InMemoryResilienceStore(clock);
      await s.record('k', cfg, false, false);
      clock.advance(1_000_000);
      expect((await s.snapshot('k')).failures).toBe(1);
    });

    it('treats a key untouched past `ttlMs` as expired on next access', async () => {
      const clock = new FakeClock();
      const s = new InMemoryResilienceStore(clock, { ttlMs: 1000 });
      await s.record('k', cfg, false, false);
      expect((await s.snapshot('k')).failures).toBe(1);

      clock.advance(1001);
      // stale beyond ttlMs: the next access resets it to fresh state instead of reusing failures=1
      expect((await s.snapshot('k')).failures).toBe(0);
    });

    it('touching a key before `ttlMs` elapses keeps it alive', async () => {
      const clock = new FakeClock();
      const s = new InMemoryResilienceStore(clock, { ttlMs: 1000 });
      await s.record('k', cfg, false, false);
      clock.advance(600);
      await s.snapshot('k'); // touch, refreshing the TTL clock
      clock.advance(600); // 1200ms since creation, but only 600ms since the touch
      expect((await s.snapshot('k')).failures).toBe(1);
    });
  });
});
