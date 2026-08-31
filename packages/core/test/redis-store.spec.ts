import { describe, expect, it, vi } from 'vitest';
import type { BreakerConfig } from '../src/index.js';
import { type Clock, FakeClock, RedisResilienceStore, redisResilienceStore } from '../src/index.js';
import type { RedisLike } from '../src/stores/redis.js';
import { makeMockRedis } from './redis-helpers.js';

const cfg: BreakerConfig = { threshold: 3, cooldownMs: 1000 };

describe('RedisResilienceStore.snapshot (structural fake)', () => {
  // Minimal fake: only the methods snapshot()/constructor touch.
  function fakeRedis(hmgetReply: (string | null)[]): RedisLike {
    return {
      defineCommand: vi.fn(),
      hmget: vi.fn(async (..._args: unknown[]) => hmgetReply),
    } as unknown as RedisLike;
  }

  it('returns the closed default for a never-seen key (no openUntil field)', async () => {
    const redis = fakeRedis([null, null, null]);
    const store = new RedisResilienceStore(redis, { keyPrefix: 'p:' });
    const snap = await store.snapshot('k');
    expect(snap).toEqual({ status: 'closed', failures: 0 });
    expect(snap.openUntil).toBeUndefined();
    // applies the configured prefix
    expect(redis.hmget).toHaveBeenCalledWith('p:k', 'status', 'failures', 'openUntil');
  });

  it('parses an open snapshot with failures and openUntil', async () => {
    const store = new RedisResilienceStore(fakeRedis(['open', '3', '5000']));
    expect(await store.snapshot('k')).toEqual({ status: 'open', failures: 3, openUntil: 5000 });
  });

  it('omits openUntil when it is 0', async () => {
    const store = new RedisResilienceStore(fakeRedis(['closed', '0', '0']));
    expect(await store.snapshot('k')).toEqual({ status: 'closed', failures: 0 });
  });

  it('defaults the namespace to agora:resilience:circuit:', async () => {
    const redis = fakeRedis([null, null, null]);
    await new RedisResilienceStore(redis).snapshot('payments');
    expect(redis.hmget).toHaveBeenCalledWith(
      'agora:resilience:circuit:payments',
      'status',
      'failures',
      'openUntil',
    );
  });
});

describe('RedisResilienceStore (ioredis-mock)', () => {
  it('counts concurrent failures atomically (no lost updates)', async () => {
    const store = redisResilienceStore(makeMockRedis(), { clock: new FakeClock() });
    // Fire many concurrent failures; the Lua HINCRBY guarantees each is counted exactly once.
    await Promise.all(
      Array.from({ length: 20 }, () => store.record('k', { ...cfg, threshold: 100 }, false, false)),
    );
    expect((await store.snapshot('k')).failures).toBe(20);
  });

  it('hands exactly one probe to concurrent admits in half-open', async () => {
    const clock = new FakeClock();
    const store = redisResilienceStore(makeMockRedis(), { clock });
    for (let i = 0; i < 3; i++) await store.record('k', cfg, false, false);
    clock.advance(1000);
    const admissions = await Promise.all(Array.from({ length: 10 }, () => store.admit('k', cfg)));
    expect(admissions.filter((a) => a.probe)).toHaveLength(1);
  });

  it('namespaces keys so two prefixes are independent on one server', async () => {
    const redis = makeMockRedis('shared-ns');
    const a = redisResilienceStore(redis, { keyPrefix: 'a:' });
    const b = redisResilienceStore(redis, { keyPrefix: 'b:' });
    for (let i = 0; i < 3; i++) await a.record('svc', cfg, false, false);
    expect((await a.snapshot('svc')).status).toBe('open');
    // The other namespace never saw a failure.
    expect((await b.snapshot('svc')).status).toBe('closed');
  });

  it('persists state across separate store instances on the same server (two pods)', async () => {
    const redisA = makeMockRedis('pods');
    const first = redisResilienceStore(redisA);
    for (let i = 0; i < 3; i++) await first.record('shared', cfg, false, false);
    expect((await first.snapshot('shared')).status).toBe('open');

    // A brand-new store + connection backed by the same mock server sees the persisted open state.
    const second = redisResilienceStore(makeMockRedis('pods'));
    expect((await second.snapshot('shared')).status).toBe('open');
    expect((await second.admit('shared', cfg)).allow).toBe(false);
  });

  it('applies a sliding TTL so idle circuits eventually expire', async () => {
    const redis = makeMockRedis();
    const store = redisResilienceStore(redis, { ttlMs: 60 });
    await store.record('k', cfg, false, false);
    expect((await store.snapshot('k')).failures).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    // After the TTL lapses the hash is gone → reads back as the closed default.
    expect(await store.snapshot('k')).toEqual({ status: 'closed', failures: 0 });
  });

  it('keeps state forever when no TTL is configured', async () => {
    const store = redisResilienceStore(makeMockRedis());
    await store.record('k', cfg, false, false);
    await new Promise((r) => setTimeout(r, 80));
    expect((await store.snapshot('k')).failures).toBe(1);
  });

  it('registers the Lua commands once per connection (idempotent)', async () => {
    const redis = makeMockRedis('reuse');
    const spy = vi.spyOn(redis, 'defineCommand');
    redisResilienceStore(redis);
    const after = redisResilienceStore(redis); // second store on same connection
    expect(after).toBeDefined();
    // Two commands registered by the first store; the second sees them already defined and skips.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('probe success closes fleet-wide; probe failure re-opens', async () => {
    const makeOpen = async (clock: Clock) => {
      const s = redisResilienceStore(makeMockRedis(), { clock });
      for (let i = 0; i < 3; i++) await s.record('k', cfg, false, false);
      return s;
    };
    const c1 = new FakeClock();
    const s1 = await makeOpen(c1);
    c1.advance(1000);
    await s1.admit('k', cfg);
    expect(await s1.record('k', cfg, true, true)).toBe('closed');

    const c2 = new FakeClock();
    const s2 = await makeOpen(c2);
    c2.advance(1000);
    await s2.admit('k', cfg);
    expect(await s2.record('k', cfg, false, true)).toBe('open');
  });
});
