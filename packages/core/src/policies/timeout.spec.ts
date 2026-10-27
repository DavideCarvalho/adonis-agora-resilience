import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../clock';
import { TimeoutError } from '../errors';
import { rootContext } from '../policy';
import { timeout } from './timeout';

describe('timeout', () => {
  it('passes through a fast result', async () => {
    const clock = new FakeClock();
    const p = timeout(100, { clock });
    await expect(p.execute(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects with TimeoutError when the op exceeds ms', async () => {
    const clock = new FakeClock();
    const p = timeout(100, { clock });
    const result = p.execute(() => new Promise(() => {})); // never resolves
    clock.advance(100);
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
  });

  it('aborts the op signal on timeout', async () => {
    const clock = new FakeClock();
    const p = timeout(100, { clock });
    let aborted = false;
    const result = p.execute(
      (ctx) =>
        new Promise<never>((_, reject) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            reject(ctx.signal.reason);
          });
        }),
    );
    clock.advance(100);
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });

  it('links the parent signal — aborting the parent aborts the op', async () => {
    const clock = new FakeClock();
    const parentAc = new AbortController();
    const p = timeout(1000, { clock });
    const result = p.execute(
      (ctx) =>
        new Promise<never>((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)),
        ),
      { signal: parentAc.signal, attempt: 0 },
    );
    parentAc.abort(new Error('parent gone'));
    await expect(result).rejects.toThrow('parent gone');
  });

  it('rejects immediately when the parent signal is already aborted before execute', async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    ac.abort(new Error('already gone'));
    const p = timeout(1000, { clock });
    const op = () => new Promise<never>(() => {});
    await expect(p.execute(op, { signal: ac.signal, attempt: 0 })).rejects.toThrow('already gone');
  });
});

describe('timeout cleanup on a synchronously-throwing op', () => {
  it('rethrows synchronously, disarms the timer and detaches from the parent signal', () => {
    const clock = new FakeClock();
    const onEvent = vi.fn();
    const ac = new AbortController();
    const p = timeout(100, { clock, onEvent });
    expect(() =>
      p.execute(
        (() => {
          throw new Error('sync boom');
        }) as never,
        { signal: ac.signal, attempt: 0 },
      ),
    ).toThrow('sync boom');
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
    clock.advance(1000);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
