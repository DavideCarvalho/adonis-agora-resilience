import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock, SystemClock } from './clock';

describe('FakeClock', () => {
  it('fires timers only after advancing past their delay', () => {
    const clock = new FakeClock();
    const cb = vi.fn();
    clock.setTimer(100, cb);
    clock.advance(99);
    expect(cb).not.toHaveBeenCalled();
    clock.advance(1);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('cancel() prevents a timer from firing', () => {
    const clock = new FakeClock();
    const cb = vi.fn();
    const cancel = clock.setTimer(10, cb);
    cancel();
    clock.advance(20);
    expect(cb).not.toHaveBeenCalled();
  });

  it('delay() resolves when time advances and rejects on abort', async () => {
    const clock = new FakeClock();
    const resolved = vi.fn();
    clock.delay(50).then(resolved);
    clock.advance(50);
    await Promise.resolve();
    expect(resolved).toHaveBeenCalled();

    const ac = new AbortController();
    const p = clock.delay(50, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
  });

  it('delay() rejects immediately when signal is already aborted', async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    ac.abort(new Error('gone'));
    await expect(clock.delay(50, ac.signal)).rejects.toThrow('gone');
    // No timers should have been scheduled
    expect(clock.now()).toBe(0);
  });
});

describe('delay() abort listener', () => {
  it('FakeClock removes its abort listener once the delay elapses', async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    const done = clock.delay(10, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(1);
    clock.advance(10);
    await done;
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('SystemClock removes its abort listener once the delay elapses', async () => {
    const ac = new AbortController();
    for (let i = 0; i < 5; i++) await new SystemClock().delay(0, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});
