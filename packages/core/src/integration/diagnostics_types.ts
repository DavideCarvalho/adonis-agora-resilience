/**
 * Typed `agora:resilience:*` channels for `@adonis-agora/diagnostics`. Type-only: nothing here runs,
 * and resilience never imports diagnostics at runtime. When diagnostics is installed,
 * `onDiagnostic('resilience', 'circuit-opened', (e) => e.payload.key)` is typed from these shapes.
 */
import type { CircuitStatus } from '../breaker/types.js';

/** A sanitized error as it travels on the bus: `{ name, message }` by default. */
export interface ResilienceBusError {
  name?: string;
  message?: string;
  [extra: string]: unknown;
}

interface Base {
  /** The named policy the event happened in; absent for inline policies. */
  policy?: string;
}

/** Payload of every `agora:resilience:*` channel, by event name. */
export interface ResilienceChannels {
  'circuit-opened': Base & { type: 'circuit-opened'; key: string };
  'circuit-closed': Base & { type: 'circuit-closed'; key: string };
  'circuit-half-open': Base & { type: 'circuit-half-open'; key: string };
  'circuit-reset': Base & {
    type: 'circuit-reset';
    key: string;
    store: string;
    previous: CircuitStatus;
    by?: string;
    via?: string;
  };
  'short-circuited': Base & { type: 'short-circuited'; key: string };
  retry: Base & { type: 'retry'; attempt: number; error?: ResilienceBusError };
  timeout: Base & { type: 'timeout'; ms: number };
  failover: Base & { type: 'failover'; target: string; index: number; error?: ResilienceBusError };
  executed: Base & {
    type: 'executed';
    policy: string;
    ok: boolean;
    ms: number;
    attempts: number;
    error?: ResilienceBusError;
  };
}

// `@adonis-agora/diagnostics` is an optional peer that is not installed here, so the augmentation
// target cannot be resolved while building; in an app that has it, the merge applies.
// biome-ignore lint/suspicious/noTsIgnore: the target module is optional and absent at build time
// @ts-ignore TS2664
declare module '@adonis-agora/diagnostics' {
  interface ChannelRegistry {
    resilience: ResilienceChannels;
  }
}
