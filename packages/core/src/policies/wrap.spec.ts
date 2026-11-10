import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../clock';
import { retry } from './retry';
import { timeout } from './timeout';
import { wrap } from './wrap';

describe('wrap', () => {
  it('runs outer→inner: retry around timeout retries a timed-out op', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const op = vi.fn(async (ctx: { signal: AbortSignal }) => {
      calls++;
      if (calls < 2) {
        // first call hangs until aborted by the timeout
        await new Promise<never>((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)),
        );
      }
      return 'ok';
    });
    const policy = wrap(retry({ attempts: 3, backoff: () => 5, clock }), timeout(100, { clock }));
    const result = policy.execute(op);
    clock.advance(100); // first attempt times out
    // flush microtasks: abort → op rejects → race rejects → timeout rejects → retry catches → backoff delay registered
    for (let i = 0; i < 10; i++) await Promise.resolve();
    clock.advance(5); // backoff fires, retry runs second attempt
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await expect(result).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('an empty wrap just runs the op', async () => {
    await expect(wrap().execute(async () => 42)).resolves.toBe(42);
  });
});
