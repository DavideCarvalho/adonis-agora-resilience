import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../clock';
import { exponential, retry } from './retry';

describe('retry', () => {
  it('returns the first success without retrying', async () => {
    const op = vi.fn(async () => 'ok');
    await expect(retry({ attempts: 3 }).execute(op)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledOnce();
  });

  it('retries up to `attempts` then rethrows the last error', async () => {
    const op = vi.fn(async () => {
      throw new Error('boom');
    });
    const clock = new FakeClock();
    const p = retry({ attempts: 3, backoff: () => 10, clock });
    const result = p.execute(op);
    // drive the two backoff delays
    await Promise.resolve();
    clock.advance(10);
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(10);
    await Promise.resolve();
    await Promise.resolve();
    await expect(result).rejects.toThrow('boom');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('exposes the 0-based attempt number to the op', async () => {
    const seen: number[] = [];
    const clock = new FakeClock();
    const op = vi.fn(async (ctx: { attempt: number }) => {
      seen.push(ctx.attempt);
      if (ctx.attempt < 2) throw new Error('again');
      return 'ok';
    });
    const result = retry({ attempts: 5, backoff: () => 1, clock }).execute(op);
    await Promise.resolve();
    clock.advance(1);
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(1);
    await Promise.resolve();
    await Promise.resolve();
    await expect(result).resolves.toBe('ok');
    expect(seen).toEqual([0, 1, 2]);
  });

  it('exponential() grows by factor', () => {
    const b = exponential(100, { factor: 2 });
    expect(b(0)).toBe(100);
    expect(b(1)).toBe(200);
    expect(b(2)).toBe(400);
  });

  it('exponential() is uncapped by default, even past sensible sizes', () => {
    const b = exponential(1000, { factor: 2 });
    expect(b(10)).toBe(1000 * 2 ** 10);
  });

  it('exponential() caps the delay at `maxMs` once the raw value exceeds it', () => {
    const b = exponential(1000, { factor: 2, maxMs: 5000 });
    expect(b(0)).toBe(1000);
    expect(b(1)).toBe(2000);
    expect(b(2)).toBe(4000);
    expect(b(3)).toBe(5000); // raw would be 8000
    expect(b(10)).toBe(5000); // stays capped for much larger attempts
  });

  it('exponential() applies `maxMs` before jitter, so jittered output never exceeds the cap', () => {
    const b = exponential(1000, { factor: 2, maxMs: 5000, jitter: true });
    for (let i = 0; i < 50; i++) {
      const delay = b(10);
      expect(delay).toBeLessThanOrEqual(5000);
      expect(delay).toBeGreaterThanOrEqual(2500); // 0.5x floor of the 5000 cap
    }
  });
});
