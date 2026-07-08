import { describe, expect, it, vi } from 'vitest';
import { combineSinks } from '../events';
import { eventEmitterSink, resilienceEventName } from './event_emitter';

describe('eventEmitterSink', () => {
  it('mirrors events as dotted resilience.* names with the event payload', () => {
    const emit = vi.fn();
    const sink = eventEmitterSink({ emit });
    sink({ type: 'circuit-opened', key: 'sms:twilio', failures: 3 });
    expect(emit).toHaveBeenCalledWith('resilience.circuit.opened', {
      type: 'circuit-opened',
      key: 'sms:twilio',
      failures: 3,
    });
  });

  it('maps every event type', () => {
    expect(resilienceEventName('circuit-half-open')).toBe('resilience.circuit.half.open');
    expect(resilienceEventName('short-circuited')).toBe('resilience.short.circuited');
    expect(resilienceEventName('retry')).toBe('resilience.retry');
  });
});

describe('combineSinks', () => {
  it('fans one event out to every sink', () => {
    const a = vi.fn();
    const b = vi.fn();
    const sink = combineSinks(a, b);
    const ev = { type: 'timeout', key: 'k', ms: 100 } as const;
    sink(ev);
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).toHaveBeenCalledWith(ev);
  });

  it('isolates a throwing sink so the others still fire', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const sink = combineSinks(bad, good);
    expect(() => sink({ type: 'retry', key: 'k' })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
