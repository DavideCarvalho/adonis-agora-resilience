export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class BrokenCircuitError extends Error {
  constructor(readonly key: string) {
    super(`Circuit "${key}" is open`);
    this.name = 'BrokenCircuitError';
  }
}

/** Why a bulkhead turned a call away. */
export type BulkheadRejection = 'full' | 'queue-full' | 'queue-timeout';

export class BulkheadRejectedError extends Error {
  constructor(
    readonly key: string,
    readonly reason: BulkheadRejection,
  ) {
    super(
      reason === 'queue-timeout'
        ? `Bulkhead "${key}" had no free slot in time`
        : `Bulkhead "${key}" is full`,
    );
    this.name = 'BulkheadRejectedError';
  }
}

export class RateLimitedError extends Error {
  constructor(
    readonly key: string,
    /** How long until the call would be allowed. */
    readonly retryAfterMs: number,
  ) {
    super(`Rate limit "${key}" exceeded, retry in ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
  }
}
