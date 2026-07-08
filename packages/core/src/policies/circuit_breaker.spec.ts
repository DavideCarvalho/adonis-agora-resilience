import { describe, expect, it, vi } from 'vitest';
import { InMemoryResilienceStore } from '../breaker/in_memory_store';
import { FakeClock } from '../clock';
import { BrokenCircuitError } from '../errors';
import { circuitBreaker } from './circuit_breaker';

const base = (store: InMemoryResilienceStore) => ({
  key: 'k',
  store,
  threshold: 3,
  cooldownMs: 1000,
});

describe('circuitBreaker', () => {
  it('passes successes through', async () => {
    const store = new InMemoryResilienceStore(new FakeClock());
    await expect(circuitBreaker(base(store)).execute(async () => 'ok')).resolves.toBe('ok');
  });

  it('opens after threshold failures and then short-circuits with BrokenCircuitError', async () => {
    const store = new InMemoryResilienceStore(new FakeClock());
    const p = circuitBreaker(base(store));
    for (let i = 0; i < 3; i++)
      await p
        .execute(async () => {
          throw new Error('boom');
        })
        .catch(() => {});
    await expect(p.execute(async () => 'should-not-run')).rejects.toBeInstanceOf(
      BrokenCircuitError,
    );
  });

  it('emits circuit-opened / short-circuited / circuit-closed', async () => {
    const clock = new FakeClock();
    const store = new InMemoryResilienceStore(clock);
    const onEvent = vi.fn();
    const p = circuitBreaker({ ...base(store), onEvent });
    for (let i = 0; i < 3; i++)
      await p
        .execute(async () => {
          throw new Error('x');
        })
        .catch(() => {});
    await p.execute(async () => 'x').catch(() => {});
    clock.advance(1000);
    await p.execute(async () => 'ok'); // probe succeeds → closed
    const types = onEvent.mock.calls.map((c) => c[0].type);
    expect(types).toContain('circuit-opened');
    expect(types).toContain('short-circuited');
    expect(types).toContain('circuit-half-open');
    expect(types).toContain('circuit-closed');
  });
});
