import { describe, expect, it } from 'vitest';
import { type Clock, FakeClock } from '../clock.js';
import type { BulkheadConfig, BulkheadStore, RateLimitConfig, RateLimitStore } from './types.js';

const bulkheadCfg: BulkheadConfig = { limit: 2, leaseMs: 1000 };

/** Shared behavioural contract every {@link BulkheadStore} must satisfy. */
export function runBulkheadStoreContract(
  name: string,
  makeStore: (clock: Clock) => BulkheadStore,
): void {
  describe(`BulkheadStore contract: ${name}`, () => {
    it('admits up to the limit and rejects past it', async () => {
      const s = makeStore(new FakeClock());
      const a = await s.acquireBulkhead('b', bulkheadCfg);
      const b = await s.acquireBulkhead('b', bulkheadCfg);
      const c = await s.acquireBulkhead('b', bulkheadCfg);
      expect([a.acquired, b.acquired, c.acquired]).toEqual([true, true, false]);
      expect(c.active).toBe(2);
      expect((await s.bulkheadSnapshot('b')).active).toBe(2);
      expect((await s.acquireBulkhead('other', bulkheadCfg)).acquired).toBe(true);
    });

    it('hands out exactly `limit` slots to concurrent acquirers', async () => {
      const s = makeStore(new FakeClock());
      const all = await Promise.all(
        Array.from({ length: 10 }, () => s.acquireBulkhead('b', bulkheadCfg)),
      );
      expect(all.filter((r) => r.acquired)).toHaveLength(2);
      expect(new Set(all.filter((r) => r.acquired).map((r) => r.leaseId)).size).toBe(2);
    });

    it('frees a slot on release', async () => {
      const s = makeStore(new FakeClock());
      const a = await s.acquireBulkhead('b', bulkheadCfg);
      await s.acquireBulkhead('b', bulkheadCfg);
      await s.releaseBulkhead('b', a.leaseId as string);
      expect((await s.bulkheadSnapshot('b')).active).toBe(1);
      expect((await s.acquireBulkhead('b', bulkheadCfg)).acquired).toBe(true);
      await s.releaseBulkhead('b', 'unknown-lease');
      expect((await s.bulkheadSnapshot('b')).active).toBe(2);
    });

    it('expires a slot whose holder never released it', async () => {
      const clock = new FakeClock();
      const s = makeStore(clock);
      await s.acquireBulkhead('b', bulkheadCfg);
      await s.acquireBulkhead('b', bulkheadCfg);
      clock.advance(1000);
      expect((await s.bulkheadSnapshot('b')).active).toBe(0);
      expect((await s.acquireBulkhead('b', bulkheadCfg)).acquired).toBe(true);
    });

    it('reset drops every slot', async () => {
      const s = makeStore(new FakeClock());
      await s.acquireBulkhead('b', bulkheadCfg);
      await s.resetBulkhead('b');
      expect((await s.bulkheadSnapshot('b')).active).toBe(0);
    });

    it('bulkheadKeys() (when implemented) lists bulkheads holding slots', async () => {
      const s = makeStore(new FakeClock());
      if (typeof s.bulkheadKeys !== 'function') return;
      await s.acquireBulkhead('api:a', bulkheadCfg);
      await s.acquireBulkhead('api:b', bulkheadCfg);
      await s.acquireBulkhead('db', bulkheadCfg);
      expect([...(await s.bulkheadKeys({ prefix: 'api:', limit: 10 }))].sort()).toEqual([
        'api:a',
        'api:b',
      ]);
      expect(await s.bulkheadKeys({ limit: 1 })).toHaveLength(1);
    });

    it('bulkheadKeys() (when implemented) leaves out bulkheads whose slots all expired', async () => {
      const clock = new FakeClock();
      const s = makeStore(clock);
      if (typeof s.bulkheadKeys !== 'function') return;
      await s.acquireBulkhead('stale', bulkheadCfg);
      clock.advance(1000);
      await s.acquireBulkhead('live', bulkheadCfg);
      expect(await s.bulkheadKeys({ limit: 10 })).toEqual(['live']);
    });
  });
}

const rateCfg: RateLimitConfig = { limit: 4, intervalMs: 1000 };

/** Shared behavioural contract every {@link RateLimitStore} must satisfy. */
export function runRateLimitStoreContract(
  name: string,
  makeStore: (clock: Clock) => RateLimitStore,
): void {
  describe(`RateLimitStore contract: ${name}`, () => {
    it('allows `limit` calls, then rejects with the time until the next token', async () => {
      const s = makeStore(new FakeClock());
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await s.consumeRateLimit('r', rateCfg, 1));
      expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, false]);
      expect(results.map((r) => r.remaining)).toEqual([3, 2, 1, 0, 0]);
      expect(results[4]?.retryAfterMs).toBe(250);
    });

    it('refills evenly over the interval, capped at the bucket size', async () => {
      const clock = new FakeClock();
      const s = makeStore(clock);
      for (let i = 0; i < 4; i++) await s.consumeRateLimit('r', rateCfg, 1);
      clock.advance(500);
      expect(await s.consumeRateLimit('r', rateCfg, 1)).toMatchObject({
        allowed: true,
        remaining: 1,
      });
      clock.advance(60_000);
      expect(await s.consumeRateLimit('r', rateCfg, 1)).toMatchObject({
        allowed: true,
        remaining: 3,
      });
    });

    it('honours burst and cost', async () => {
      const s = makeStore(new FakeClock());
      const cfg: RateLimitConfig = { limit: 2, intervalMs: 1000, burst: 6 };
      expect(await s.consumeRateLimit('r', cfg, 5)).toMatchObject({ allowed: true, remaining: 1 });
      expect(await s.consumeRateLimit('r', cfg, 2)).toMatchObject({
        allowed: false,
        remaining: 1,
        retryAfterMs: 500,
      });
    });

    it('never over-admits under concurrent consumers', async () => {
      const s = makeStore(new FakeClock());
      const all = await Promise.all(
        Array.from({ length: 10 }, () => s.consumeRateLimit('r', rateCfg, 1)),
      );
      expect(all.filter((r) => r.allowed)).toHaveLength(4);
    });

    it('snapshot reads an unused bucket as empty state, and reset refills it', async () => {
      const s = makeStore(new FakeClock());
      expect((await s.rateLimitSnapshot('r')).tokens).toBeUndefined();
      await s.consumeRateLimit('r', rateCfg, 3);
      expect((await s.rateLimitSnapshot('r')).tokens).toBe(1);
      await s.resetRateLimit('r');
      expect((await s.rateLimitSnapshot('r')).tokens).toBeUndefined();
      expect(await s.consumeRateLimit('r', rateCfg, 4)).toMatchObject({ allowed: true });
    });

    it('rateLimitKeys() (when implemented) lists buckets in use', async () => {
      const s = makeStore(new FakeClock());
      if (typeof s.rateLimitKeys !== 'function') return;
      await s.consumeRateLimit('sms:a', rateCfg, 1);
      await s.consumeRateLimit('sms:b', rateCfg, 1);
      await s.consumeRateLimit('mail', rateCfg, 1);
      expect([...(await s.rateLimitKeys({ prefix: 'sms:', limit: 10 }))].sort()).toEqual([
        'sms:a',
        'sms:b',
      ]);
    });

    it('forgets a bucket once it has been idle long enough to be full again', async () => {
      const clock = new FakeClock();
      const s = makeStore(clock);
      await s.consumeRateLimit('idle', rateCfg, 4);
      clock.advance(1000);
      expect((await s.rateLimitSnapshot('idle')).tokens).toBeUndefined();
      if (typeof s.rateLimitKeys === 'function') {
        expect(await s.rateLimitKeys({ limit: 10 })).toEqual([]);
      }
    });

    it('snapshot carries the store clock', async () => {
      const clock = new FakeClock();
      const s = makeStore(clock);
      clock.advance(1234);
      const now = (await s.rateLimitSnapshot('r')).now;
      if (now !== undefined) expect(now).toBe(1234);
    });
  });
}
