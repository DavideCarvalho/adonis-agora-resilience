export type CircuitStatus = 'closed' | 'open' | 'half-open';

export interface CircuitSnapshot {
  status: CircuitStatus;
  failures: number;
  openUntil?: number;
  /** When the store first wrote the circuit (SQL stores; absent on rows written before). */
  createdAt?: Date;
  /** When its state last changed (SQL stores; absent on rows written before). */
  updatedAt?: Date;
}

export interface BreakerConfig {
  threshold: number;
  cooldownMs: number;
  /** Max concurrent probes allowed in half-open. Default 1. */
  halfOpenMax?: number;
}

export interface Admission {
  allow: boolean;
  probe: boolean;
  status: CircuitStatus;
}
