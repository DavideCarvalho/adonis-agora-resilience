import { afterEach, describe, expect, it } from 'vitest';
import type { ResilienceEvent } from '../events.js';
import { diagnosticsSink } from './diagnostics.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
});

describe('diagnosticsSink', () => {
  it('republishes resilience events through the global emit slot', () => {
    const calls: any[] = [];
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => calls.push({ lib, event, payload });

    const event = { type: 'circuit-opened', key: 'db', at: 0 } as unknown as ResilienceEvent;
    diagnosticsSink()(event);

    expect(calls).toHaveLength(1);
    expect(calls[0].lib).toBe('resilience');
    expect(calls[0].event).toBe('circuit-opened');
    expect(calls[0].payload.key).toBe('db');
  });

  it('no-ops when @adonis-agora/diagnostics is not installed', () => {
    const event = { type: 'circuit-opened', key: 'db', at: 0 } as unknown as ResilienceEvent;
    expect(() => diagnosticsSink()(event)).not.toThrow();
  });

  it('sanitizes a raw error down to { name, message } by default, dropping sensitive fields', () => {
    const calls: any[] = [];
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => calls.push({ lib, event, payload });

    const sensitive = Object.assign(new Error('upstream rejected the request'), {
      response: { body: { apiKey: 'sk-live-secret' }, headers: { authorization: 'Bearer secret' } },
    });
    const event = { type: 'retry', attempt: 1, error: sensitive } as unknown as ResilienceEvent;
    diagnosticsSink()(event);

    expect(calls).toHaveLength(1);
    const forwarded = calls[0].payload.error;
    expect(forwarded).toEqual({ name: 'Error', message: 'upstream rejected the request' });
    expect(JSON.stringify(forwarded)).not.toContain('sk-live-secret');
    expect(JSON.stringify(forwarded)).not.toContain('Bearer secret');
    // the original event object handed to onEvent callbacks is untouched
    expect((event as any).error).toBe(sensitive);
  });

  it('leaves events without an `error` field untouched', () => {
    const calls: any[] = [];
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => calls.push({ lib, event, payload });

    const event = { type: 'circuit-opened', key: 'db' } as unknown as ResilienceEvent;
    diagnosticsSink()(event);
    expect(calls[0].payload).toEqual(event);
  });

  it('supports an opted-in custom sanitizeError', () => {
    const calls: any[] = [];
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => calls.push({ lib, event, payload });

    const err = Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' });
    const event = { type: 'retry', attempt: 1, error: err } as unknown as ResilienceEvent;
    diagnosticsSink({
      sanitizeError: (e) => ({
        name: (e as Error).name,
        message: (e as Error).message,
        code: (e as any).code,
      }),
    })(event);

    expect(calls[0].payload.error).toEqual({
      name: 'Error',
      message: 'rate limited',
      code: 'RATE_LIMIT',
    });
  });
});
