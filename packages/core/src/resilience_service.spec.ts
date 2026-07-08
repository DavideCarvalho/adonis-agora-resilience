import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryResilienceStore } from './breaker/in_memory_store.js';
import { FakeClock } from './clock.js';
import { circuitBreaker } from './policies/circuit_breaker.js';
import { retry } from './policies/retry.js';
import { timeout } from './policies/timeout.js';
import { ResilienceService } from './resilience_service.js';

describe('ResilienceService', () => {
  afterEach(() => {
    // nothing global to reset
  });

  it('runs an operation through an ad-hoc policy', async () => {
    const svc = new ResilienceService({ emit: false });
    const result = await svc.execute(timeout(1000), async () => 42);
    expect(result).toBe(42);
  });

  it('resolves and runs a named policy', async () => {
    let attempts = 0;
    const svc = new ResilienceService({
      emit: false,
      policies: { flaky: () => retry({ attempts: 3 }) },
    });
    const result = await svc.execute('flaky', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('throws for an unknown named policy', () => {
    const svc = new ResilienceService({ emit: false });
    // resolve() runs synchronously before the operation promise is created.
    expect(() => svc.execute('nope', async () => 1)).toThrow(/Unknown resilience policy/);
  });

  it('exposes per-circuit snapshot + reset over the store', async () => {
    const store = new InMemoryResilienceStore();
    const svc = new ResilienceService({ emit: false, store });
    const snap = await svc.circuit('db').snapshot();
    expect(snap.status).toBe('closed');
    await expect(svc.circuit('db').reset()).resolves.toBeUndefined();
  });

  it('threads the service sink into a named policy so execute() delivers events to the emitter', async () => {
    const emit = vi.fn();
    const store = new InMemoryResilienceStore(new FakeClock());
    const svc = new ResilienceService({
      eventEmitter: { emit },
      store,
      policies: {
        payments: () => circuitBreaker({ key: 'payments', store, threshold: 3, cooldownMs: 1000 }),
      },
    });
    const failing = async (): Promise<never> => {
      throw new Error('boom');
    };
    // Trip the breaker: three failures reach the shared store and open the circuit.
    for (let i = 0; i < 3; i++) await svc.execute('payments', failing).catch(() => {});
    const names = emit.mock.calls.map((c) => c[0]);
    expect(names).toContain('resilience.circuit.opened');
  });

  it('combines an explicit policy onEvent with the injected service sink (both fire)', async () => {
    const emit = vi.fn();
    const spy = vi.fn();
    const store = new InMemoryResilienceStore(new FakeClock());
    const svc = new ResilienceService({
      eventEmitter: { emit },
      store,
      policies: {
        payments: () =>
          circuitBreaker({ key: 'payments', store, threshold: 3, cooldownMs: 1000, onEvent: spy }),
      },
    });
    const failing = async (): Promise<never> => {
      throw new Error('boom');
    };
    for (let i = 0; i < 3; i++) await svc.execute('payments', failing).catch(() => {});
    expect(spy.mock.calls.map((c) => c[0].type)).toContain('circuit-opened');
    expect(emit.mock.calls.map((c) => c[0])).toContain('resilience.circuit.opened');
  });

  it('delivers timeout events on the execute path', async () => {
    const emit = vi.fn();
    const clock = new FakeClock();
    const svc = new ResilienceService({
      eventEmitter: { emit },
      policies: { slow: () => timeout(50, { clock }) },
    });
    const settled = svc.execute('slow', () => new Promise<never>(() => {})).catch(() => {});
    clock.advance(50); // fire the timeout timer
    await settled;
    expect(emit.mock.calls.map((c) => c[0])).toContain('resilience.timeout');
  });

  it('delivers retry events on the execute path', async () => {
    const emit = vi.fn();
    const svc = new ResilienceService({
      eventEmitter: { emit },
      policies: { flaky: () => retry({ attempts: 2 }) },
    });
    await svc
      .execute('flaky', async () => {
        throw new Error('always');
      })
      .catch(() => {});
    expect(emit.mock.calls.map((c) => c[0])).toContain('resilience.retry');
  });
});
