import { describe, expect, it, vi } from 'vitest';
import { InMemoryResilienceStore } from './breaker/in_memory_store';
import { FakeClock } from './clock';
import { withResilience } from './decorator';
import { BrokenCircuitError } from './errors';
import { circuitBreaker } from './policies/circuit_breaker';
import { retry } from './policies/retry';
import { timeout } from './policies/timeout';

describe('withResilience', () => {
  it('preserves `this`, arguments, and the return value', async () => {
    class Greeter {
      greeting = 'hello';
      @withResilience()
      async greet(name: string, punct: string): Promise<string> {
        return `${this.greeting} ${name}${punct}`;
      }
    }
    const g = new Greeter();
    await expect(g.greet('world', '!')).resolves.toBe('hello world!');
  });

  it('retries a failing method exactly like the equivalent wrap(...) call', async () => {
    const clock = new FakeClock();
    let calls = 0;
    class Svc {
      @withResilience(retry({ attempts: 3, backoff: () => 10, clock }))
      async run(): Promise<string> {
        calls++;
        if (calls < 3) throw new Error('boom');
        return 'ok';
      }
    }
    const result = new Svc().run();
    await Promise.resolve();
    clock.advance(10);
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(10);
    await Promise.resolve();
    await Promise.resolve();
    await expect(result).resolves.toBe('ok');
    expect(calls).toBe(3);
  });

  it('times out a hanging method', async () => {
    const clock = new FakeClock();
    class Svc {
      @withResilience(timeout(100, { clock }))
      async run(): Promise<never> {
        return new Promise<never>(() => {});
      }
    }
    const result = new Svc().run();
    const assertion = expect(result).rejects.toThrow('timed out');
    clock.advance(100);
    await assertion;
  });

  it('short-circuits once the breaker opens, identical to wrap(circuitBreaker(...))', async () => {
    const store = new InMemoryResilienceStore();
    class Svc {
      @withResilience(circuitBreaker({ key: 'svc', store, threshold: 2, cooldownMs: 1000 }))
      async run(): Promise<string> {
        throw new Error('downstream down');
      }
    }
    const svc = new Svc();
    await expect(svc.run()).rejects.toThrow('downstream down');
    await expect(svc.run()).rejects.toThrow('downstream down');
    // breaker is now open → next call is short-circuited
    await expect(svc.run()).rejects.toBeInstanceOf(BrokenCircuitError);
  });

  it('applies policies outer→inner, matching wrap(...) order', async () => {
    const order: string[] = [];
    const tracer = (label: string) => ({
      execute<T>(op: (ctx: { signal: AbortSignal; attempt: number }) => Promise<T>) {
        order.push(`enter:${label}`);
        return op({ signal: new AbortController().signal, attempt: 0 }).finally(() =>
          order.push(`exit:${label}`),
        );
      },
    });
    class Svc {
      @withResilience(tracer('outer'), tracer('inner'))
      async run(): Promise<string> {
        order.push('body');
        return 'ok';
      }
    }
    await new Svc().run();
    // outer entered first, exited last — same nesting as wrap(outer, inner)
    expect(order).toEqual(['enter:outer', 'enter:inner', 'body', 'exit:inner', 'exit:outer']);
  });

  it('forwards arguments through the policy pipeline on each retry', async () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    let calls = 0;
    class Svc {
      @withResilience(retry({ attempts: 2, backoff: () => 5, clock }))
      async run(n: number): Promise<number> {
        seen.push(n);
        calls++;
        if (calls < 2) throw new Error('again');
        return n * 2;
      }
    }
    const result = new Svc().run(21);
    await Promise.resolve();
    clock.advance(5);
    await Promise.resolve();
    await Promise.resolve();
    await expect(result).resolves.toBe(42);
    expect(seen).toEqual([21, 21]);
  });

  it('an empty @withResilience() just runs the method', async () => {
    const op = vi.fn(async () => 7);
    class Svc {
      @withResilience()
      async run(): Promise<number> {
        return op();
      }
    }
    await expect(new Svc().run()).resolves.toBe(7);
    expect(op).toHaveBeenCalledOnce();
  });
});
