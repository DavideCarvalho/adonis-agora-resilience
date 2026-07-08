import type { EventSink, ResilienceEvent } from '../events.js';

/** Structural subset of EventEmitter2 — avoids importing @nestjs/event-emitter into core. */
export interface EventEmitterLike {
  emit(event: string, ...values: unknown[]): unknown;
}

/** Map a ResilienceEvent type to a dotted event name: `circuit-opened` → `resilience.circuit.opened`. */
export function resilienceEventName(type: string): string {
  return `resilience.${type.replace(/-/g, '.')}`;
}

/** An EventSink that mirrors each ResilienceEvent to an EventEmitter2-style emitter. */
export function eventEmitterSink(emitter: EventEmitterLike): EventSink {
  return (event: ResilienceEvent) => {
    emitter.emit(resilienceEventName(event.type), event);
  };
}
