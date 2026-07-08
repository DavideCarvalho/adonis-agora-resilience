import { type Clock, systemClock } from '../clock.js';
import {
  type CircuitState,
  INITIAL_CIRCUIT_STATE,
  computeAdmit,
  computeRecord,
} from './state_machine.js';
import type { ResilienceStore } from './store.js';
import type { Admission, BreakerConfig, CircuitSnapshot, CircuitStatus } from './types.js';

/**
 * Parameter placeholder dialect.
 * - `numbered`: Postgres-style `$1, $2, …` (TypeORM, Prisma).
 * - `positional`: `?` (MikroORM and most other drivers).
 */
export type SqlPlaceholderStyle = 'numbered' | 'positional';

/** DDL — idempotent, safe to run on every startup. Placeholder-free, so identical across dialects. */
export const CIRCUITS_DDL = `
CREATE TABLE IF NOT EXISTS resilience_circuits (
  key        TEXT PRIMARY KEY,
  status     TEXT    NOT NULL DEFAULT 'closed',
  failures   INTEGER NOT NULL DEFAULT 0,
  open_until BIGINT  NOT NULL DEFAULT 0,
  probes     INTEGER NOT NULL DEFAULT 0
);`;

interface SqlStatements {
  insertInitial: string;
  selectForUpdate: string;
  selectPlain: string;
  updateState: string;
  deleteRow: string;
}

/**
 * Build the statement set for a dialect. Single source of truth for the breaker's SQL — including
 * whether the pessimistic read carries `FOR UPDATE`. Dialects without row-lock syntax (SQLite) pass
 * `lockRows: false` and the clause is simply omitted here, so no adapter ever rewrites SQL by hand.
 */
function statements(style: SqlPlaceholderStyle, lockRows: boolean): SqlStatements {
  const p = style === 'numbered' ? (n: number) => `$${n}` : () => '?';
  const forUpdate = lockRows ? '\nFOR UPDATE' : '';
  return {
    // Ensure the row exists (no-op if already present).
    insertInitial: `
INSERT INTO resilience_circuits (key, status, failures, open_until, probes)
VALUES (${p(1)}, 'closed', 0, 0, 0)
ON CONFLICT (key) DO NOTHING;`,
    // Pessimistic read — must run inside the same transaction as insertInitial. The `FOR UPDATE`
    // row lock is included only when the dialect supports it (see `lockRows`); on a single-writer
    // dialect like SQLite, transaction-level write serialisation preserves the same atomicity.
    selectForUpdate: `
SELECT status, failures, open_until, probes
FROM resilience_circuits
WHERE key = ${p(1)}${forUpdate};`,
    // Non-locking read for snapshot().
    selectPlain: `
SELECT status, failures, open_until, probes
FROM resilience_circuits
WHERE key = ${p(1)};`,
    // Persist the new state. Parameters: status, failures, open_until, probes, key.
    updateState: `
UPDATE resilience_circuits
SET status = ${p(1)}, failures = ${p(2)}, open_until = ${p(3)}, probes = ${p(4)}
WHERE key = ${p(5)};`,
    // Clear a circuit back to its initial state (reset()). A missing row is a no-op.
    deleteRow: `
DELETE FROM resilience_circuits
WHERE key = ${p(1)};`,
  };
}

/** Map a raw SQL row (or undefined) to a CircuitState. */
function rowToState(row: Record<string, unknown> | undefined): CircuitState {
  if (!row) return { ...INITIAL_CIRCUIT_STATE };
  return {
    status: row.status as CircuitStatus,
    failures: Number(row.failures),
    openUntil: Number(row.open_until),
    probes: Number(row.probes),
  };
}

/** Parameterized statement runner, scoped to a single transaction. */
export interface SqlTx {
  /** Execute a write (INSERT/UPDATE); the result is discarded. */
  run(sql: string, params: unknown[]): Promise<void>;
  /** Execute a read and return the rows. */
  all(sql: string, params: unknown[]): Promise<unknown[]>;
}

/**
 * Minimal per-ORM contract. An adapter supplies only the dialect plus how to run a transaction,
 * a non-transactional read, and a DDL statement — everything else (the load→compute→persist
 * orchestration and the SQL itself) lives in {@link SqlResilienceStore}.
 */
export interface SqlDriver {
  readonly placeholders: SqlPlaceholderStyle;
  /**
   * Whether the dialect supports `SELECT … FOR UPDATE` row locks. When `false`, the locking read is
   * generated without the clause (the dialect — e.g. SQLite — must serialise transaction writers
   * itself). Defaults to `true` when omitted.
   */
  readonly lockRows?: boolean;
  /** Run `body` inside one atomic transaction (the breaker relies on `FOR UPDATE` locking within it). */
  transaction<R>(body: (tx: SqlTx) => Promise<R>): Promise<R>;
  /** Non-transactional read, used by `snapshot()`. */
  read(sql: string, params: unknown[]): Promise<unknown[]>;
  /** Run a DDL statement (no parameters). */
  exec(sql: string): Promise<void>;
}

export interface SqlResilienceStoreOptions {
  clock?: Clock;
}

/**
 * SQL-backed {@link ResilienceStore} shared by every relational adapter. Each adapter package is
 * reduced to a tiny {@link SqlDriver}; this class owns the atomic load→compute→persist cycle and
 * the dialect-aware statements, so breaker semantics live in exactly one place.
 */
export class SqlResilienceStore implements ResilienceStore {
  private readonly stmts: SqlStatements;
  private readonly clock: Clock;

  constructor(
    private readonly driver: SqlDriver,
    opts: SqlResilienceStoreOptions = {},
  ) {
    this.stmts = statements(driver.placeholders, driver.lockRows ?? true);
    this.clock = opts.clock ?? systemClock;
  }

  ensureSchema(): Promise<void> {
    return this.driver.exec(CIRCUITS_DDL);
  }

  admit(key: string, cfg: BreakerConfig): Promise<Admission> {
    return this.driver.transaction(async (tx): Promise<Admission> => {
      await tx.run(this.stmts.insertInitial, [key]);
      const rows = await tx.all(this.stmts.selectForUpdate, [key]);
      const { state, admission } = computeAdmit(
        rowToState(rows[0] as Record<string, unknown> | undefined),
        cfg,
        this.clock.now(),
      );
      await tx.run(this.stmts.updateState, [
        state.status,
        state.failures,
        state.openUntil,
        state.probes,
        key,
      ]);
      return admission;
    });
  }

  record(key: string, cfg: BreakerConfig, ok: boolean, probe: boolean): Promise<CircuitStatus> {
    return this.driver.transaction(async (tx): Promise<CircuitStatus> => {
      await tx.run(this.stmts.insertInitial, [key]);
      const rows = await tx.all(this.stmts.selectForUpdate, [key]);
      const { state, status } = computeRecord(
        rowToState(rows[0] as Record<string, unknown> | undefined),
        cfg,
        ok,
        probe,
        this.clock.now(),
      );
      await tx.run(this.stmts.updateState, [
        state.status,
        state.failures,
        state.openUntil,
        state.probes,
        key,
      ]);
      return status;
    });
  }

  async snapshot(key: string): Promise<CircuitSnapshot> {
    const rows = await this.driver.read(this.stmts.selectPlain, [key]);
    const s = rowToState(rows[0] as Record<string, unknown> | undefined);
    return {
      status: s.status,
      failures: s.failures,
      ...(s.openUntil ? { openUntil: s.openUntil } : {}),
    };
  }

  reset(key: string): Promise<void> {
    return this.driver.transaction(async (tx) => {
      await tx.run(this.stmts.deleteRow, [key]);
    });
  }
}
