import type { Policy } from './policy.js';

const DESCRIBE = Symbol.for('@agora/resilience:describe');

/** Format a duration the way policy descriptions read: `200ms`, `2s`, `1.5s`, `5m`, `1h`. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms < 1000) return `${ms}ms`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Number((ms / 1000).toFixed(3))}s`;
}

/**
 * Attach a description to a value (a policy or a backoff function) without making it enumerable,
 * so it never shows up when the value is spread, logged or serialized.
 */
export function tagDescription<T extends object>(target: T, description: readonly string[]): T {
  Object.defineProperty(target, DESCRIBE, {
    value: Object.freeze([...description]),
    enumerable: false,
    configurable: true,
  });
  return target;
}

/** The description attached by {@link tagDescription}, or `undefined`. */
export function readDescription(target: unknown): readonly string[] | undefined {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) return;
  const value = (target as Record<symbol, unknown>)[DESCRIBE];
  return Array.isArray(value) ? (value as string[]) : undefined;
}

/**
 * What a policy is made of, as one line per building block:
 * `['timeout(2s)', 'retry(3, exp 200ms)', 'circuit-breaker(key=stripe, threshold=5, cooldown=30s)']`.
 * Built-in policies describe themselves; anything else reads `['custom']`.
 */
export function describePolicy(policy: Policy): string[] {
  const description = readDescription(policy);
  return description ? [...description] : ['custom'];
}
