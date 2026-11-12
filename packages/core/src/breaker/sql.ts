import { randomUUID } from 'node:crypto';
import { type Clock, systemClock } from '../clock.js';
import { type BucketState, bucketTtlMs, consumeTokens } from '../limits/token_bucket.js';
import type {
  BulkheadAdmission,
  BulkheadConfig,
  BulkheadSnapshot,
  BulkheadStore,
  RateLimitConfig,
  RateLimitDecision,
  RateLimitSnapshot,
  RateLimitStore,
} from '../limits/types.js';
import {
  type CircuitState,
  computeAdmit,
  computeRecord,
  INITIAL_CIRCUIT_STATE,
} from './state_machine.js';
import type { KeysQuery, ResilienceStore } from './store.js';
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

/**
 * Bulkhead slots: one row per held slot, plus one anchor row per key (`lease_id = ''`) that acquirers
 * lock to serialise the count-then-insert. Idempotent.
 */
export const BULKHEADS_DDL = `
CREATE TABLE IF NOT EXISTS resilience_bulkhead_leases (
  key        TEXT   NOT NULL,
  lease_id   TEXT   NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (key, lease_id)
);`;

/** Rate-limiter buckets: tokens left and when they were last counted. Idempotent. */
export const RATE_LIMITS_DDL = `
CREATE TABLE IF NOT EXISTS resilience_rate_limits (
  key        TEXT PRIMARY KEY,
  tokens     DOUBLE PRECISION NOT NULL,
  updated_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);`;

/** Every table the SQL stores use: circuits, bulkhead slots and rate-limiter buckets. */
export const RESILIENCE_DDL: readonly string[] = [CIRCUITS_DDL, BULKHEADS_DDL, RATE_LIMITS_DDL];

interface LimitStatements {
  insertAnchor: string;
  lockAnchor: string;
  deleteExpired: string;
  countLeases: string;
  insertLease: string;
  deleteLease: string;
  deleteBulkhead: string;
  listBulkheadKeys: (limit: number) => string;
  insertBucket: string;
  lockBucket: string;
  readBucket: string;
  updateBucket: string;
  deleteBucket: string;
  listBucketKeys: (limit: number) => string;
}

function limitStatements(style: SqlPlaceholderStyle, lockRows: boolean): LimitStatements {
  const p = style === 'numbered' ? (n: number) => `$${n}` : () => '?';
  const forUpdate = lockRows ? '\nFOR UPDATE' : '';
  return {
    insertAnchor: `
INSERT INTO resilience_bulkhead_leases (key, lease_id, expires_at)
VALUES (${p(1)}, '', 0)
ON CONFLICT (key, lease_id) DO NOTHING;`,
    lockAnchor: `
SELECT key FROM resilience_bulkhead_leases
WHERE key = ${p(1)} AND lease_id = ''${forUpdate};`,
    deleteExpired: `
DELETE FROM resilience_bulkhead_leases
WHERE key = ${p(1)} AND lease_id <> '' AND expires_at <= ${p(2)};`,
    countLeases: `
SELECT COUNT(*) AS n FROM resilience_bulkhead_leases
WHERE key = ${p(1)} AND lease_id <> '' AND expires_at > ${p(2)};`,
    insertLease: `
INSERT INTO resilience_bulkhead_leases (key, lease_id, expires_at)
VALUES (${p(1)}, ${p(2)}, ${p(3)});`,
    deleteLease: `
DELETE FROM resilience_bulkhead_leases
WHERE key = ${p(1)} AND lease_id = ${p(2)};`,
    deleteBulkhead: `
DELETE FROM resilience_bulkhead_leases
WHERE key = ${p(1)};`,
    listBulkheadKeys: (limit) => `
SELECT DISTINCT key FROM resilience_bulkhead_leases
WHERE key LIKE ${p(1)} ESCAPE '!' AND lease_id <> '' AND expires_at > ${p(2)}
ORDER BY key
LIMIT ${limit};`,
    // A new bucket is written with tokens = -1, read back as "never used" (full).
    insertBucket: `
INSERT INTO resilience_rate_limits (key, tokens, updated_at, expires_at)
VALUES (${p(1)}, -1, 0, 0)
ON CONFLICT (key) DO NOTHING;`,
    lockBucket: `
SELECT tokens, updated_at, expires_at FROM resilience_rate_limits
WHERE key = ${p(1)}${forUpdate};`,
    readBucket: `
SELECT tokens, updated_at, expires_at FROM resilience_rate_limits
WHERE key = ${p(1)};`,
    updateBucket: `
UPDATE resilience_rate_limits
SET tokens = ${p(1)}, updated_at = ${p(2)}, expires_at = ${p(3)}
WHERE key = ${p(4)};`,
    deleteBucket: `
DELETE FROM resilience_rate_limits
WHERE key = ${p(1)};`,
    listBucketKeys: (limit) => `
SELECT key FROM resilience_rate_limits
WHERE key LIKE ${p(1)} ESCAPE '!' AND expires_at > ${p(2)}
ORDER BY key
LIMIT ${limit};`,
  };
}

/** A stored bucket, or undefined when never used or idle long enough to be full again. */
function rowToBucket(
  row: Record<string, unknown> | undefined,
  now: number,
): BucketState | undefined {
  if (!row) return undefined;
  const tokens = Number(row.tokens);
  if (!(tokens >= 0) || Number(row.expires_at) <= now) return undefined;
  return { tokens, updatedAt: Number(row.updated_at) };
}

function clampKeysLimit(limit: number): number {
  return Math.max(0, Math.min(10_000, Math.floor(limit)));
}

interface SqlStatements {
  insertInitial: string;
  selectForUpdate: string;
  selectPlain: string;
  updateState: string;
  closeIfDirty: string;
  deleteRow: string;
  listKeys: (limit: number) => string;
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
    // Close after a success, matching no row when the circuit is already clean (or absent), so the
    // steady closed state is never rewritten. `probes` is left untouched, as in computeRecord.
    closeIfDirty: `
UPDATE resilience_circuits
SET status = 'closed', failures = 0, open_until = 0
WHERE key = ${p(1)} AND (status <> 'closed' OR failures <> 0 OR open_until <> 0);`,
    // Clear a circuit back to its initial state (reset()). A missing row is a no-op.
    deleteRow: `
DELETE FROM resilience_circuits
WHERE key = ${p(1)};`,
    // List keys by prefix (LIKE with an explicit escape character). `limit` is a validated integer.
    listKeys: (limit) => `
SELECT key FROM resilience_circuits
WHERE key LIKE ${p(1)} ESCAPE '!'
ORDER BY key
LIMIT ${limit};`,
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

/** A `LIKE` pattern matching every key that starts with `prefix` (`!` escapes the wildcards). */
export function likePrefix(prefix: string | undefined): string {
  return `${(prefix ?? '').replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

function sameState(a: CircuitState, b: CircuitState): boolean {
  return (
    a.status === b.status &&
    a.failures === b.failures &&
    a.openUntil === b.openUntil &&
    a.probes === b.probes
  );
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
  /** Non-transactional read, used by `snapshot()` and the lock-free `admit()` path. */
  read(sql: string, params: unknown[]): Promise<unknown[]>;
  /** Non-transactional single-statement write, used by the lock-free clean-success path. */
  run(sql: string, params: unknown[]): Promise<void>;
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
export class SqlResilienceStore implements ResilienceStore, BulkheadStore, RateLimitStore {
  private readonly stmts: SqlStatements;
  private readonly limits: LimitStatements;
  private readonly clock: Clock;

  constructor(
    private readonly driver: SqlDriver,
    opts: SqlResilienceStoreOptions = {},
  ) {
    this.stmts = statements(driver.placeholders, driver.lockRows ?? true);
    this.limits = limitStatements(driver.placeholders, driver.lockRows ?? true);
    this.clock = opts.clock ?? systemClock;
  }

  /** Create every table the store uses (circuits, bulkhead slots, rate-limiter buckets). */
  async ensureSchema(): Promise<void> {
    for (const ddl of RESILIENCE_DDL) await this.driver.exec(ddl);
  }

  /**
   * A closed circuit, an open one still cooling down, or a half-open one with every probe slot taken
   * admits without changing state, so those are answered from a plain read. Only a transition
   * (open → half-open, or granting a probe) takes the row lock and re-decides on the locked row,
   * which keeps half-open probe admission exclusive.
   */
  async admit(key: string, cfg: BreakerConfig): Promise<Admission> {
    const now = this.clock.now();
    const rows = await this.driver.read(this.stmts.selectPlain, [key]);
    const prev = rowToState(rows[0] as Record<string, unknown> | undefined);
    const { state, admission } = computeAdmit(prev, cfg, now);
    if (sameState(prev, state)) return admission;
    return this.driver.transaction(async (tx): Promise<Admission> => {
      await tx.run(this.stmts.insertInitial, [key]);
      const locked = await tx.all(this.stmts.selectForUpdate, [key]);
      const next = computeAdmit(
        rowToState(locked[0] as Record<string, unknown> | undefined),
        cfg,
        now,
      );
      await tx.run(this.stmts.updateState, [
        next.state.status,
        next.state.failures,
        next.state.openUntil,
        next.state.probes,
        key,
      ]);
      return next.admission;
    });
  }

  /**
   * A non-probe success always lands on closed with no failures whatever the previous state, so it is
   * a single conditional UPDATE that writes nothing when the circuit is already clean. Failures and
   * probe outcomes depend on the current row and go through the locked load→compute→persist cycle.
   */
  async record(
    key: string,
    cfg: BreakerConfig,
    ok: boolean,
    probe: boolean,
  ): Promise<CircuitStatus> {
    if (ok && !probe) {
      await this.driver.run(this.stmts.closeIfDirty, [key]);
      return 'closed';
    }
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

  async keys(opts: KeysQuery): Promise<string[]> {
    const limit = Math.max(0, Math.min(10_000, Math.floor(opts.limit)));
    if (limit === 0) return [];
    const rows = await this.driver.read(this.stmts.listKeys(limit), [likePrefix(opts.prefix)]);
    return rows.map((row) => String((row as Record<string, unknown>).key));
  }

  reset(key: string): Promise<void> {
    return this.driver.transaction(async (tx) => {
      await tx.run(this.stmts.deleteRow, [key]);
    });
  }

  // ── bulkheads ──────────────────────────────────────────────────────────────────────────────

  acquireBulkhead(key: string, cfg: BulkheadConfig): Promise<BulkheadAdmission> {
    const now = this.clock.now();
    return this.driver.transaction(async (tx): Promise<BulkheadAdmission> => {
      await tx.run(this.limits.insertAnchor, [key]);
      await tx.all(this.limits.lockAnchor, [key]);
      await tx.run(this.limits.deleteExpired, [key, now]);
      const rows = await tx.all(this.limits.countLeases, [key, now]);
      const active = Number((rows[0] as Record<string, unknown> | undefined)?.n ?? 0);
      if (active >= cfg.limit) return { acquired: false, active };
      const leaseId = randomUUID();
      await tx.run(this.limits.insertLease, [key, leaseId, now + cfg.leaseMs]);
      return { acquired: true, leaseId, active: active + 1 };
    });
  }

  releaseBulkhead(key: string, leaseId: string): Promise<void> {
    return this.driver.run(this.limits.deleteLease, [key, leaseId]);
  }

  async bulkheadSnapshot(key: string): Promise<BulkheadSnapshot> {
    const rows = await this.driver.read(this.limits.countLeases, [key, this.clock.now()]);
    return { active: Number((rows[0] as Record<string, unknown> | undefined)?.n ?? 0) };
  }

  resetBulkhead(key: string): Promise<void> {
    return this.driver.run(this.limits.deleteBulkhead, [key]);
  }

  async bulkheadKeys(opts: KeysQuery): Promise<string[]> {
    const limit = clampKeysLimit(opts.limit);
    if (limit === 0) return [];
    const rows = await this.driver.read(this.limits.listBulkheadKeys(limit), [
      likePrefix(opts.prefix),
      this.clock.now(),
    ]);
    return rows.map((row) => String((row as Record<string, unknown>).key));
  }

  // ── rate limiters ──────────────────────────────────────────────────────────────────────────

  consumeRateLimit(key: string, cfg: RateLimitConfig, cost: number): Promise<RateLimitDecision> {
    const now = this.clock.now();
    return this.driver.transaction(async (tx): Promise<RateLimitDecision> => {
      await tx.run(this.limits.insertBucket, [key]);
      const rows = await tx.all(this.limits.lockBucket, [key]);
      const { state, decision } = consumeTokens(
        rowToBucket(rows[0] as Record<string, unknown> | undefined, now),
        cfg,
        cost,
        now,
      );
      await tx.run(this.limits.updateBucket, [
        state.tokens,
        state.updatedAt,
        now + bucketTtlMs(cfg),
        key,
      ]);
      return decision;
    });
  }

  async rateLimitSnapshot(key: string): Promise<RateLimitSnapshot> {
    const now = this.clock.now();
    const rows = await this.driver.read(this.limits.readBucket, [key]);
    const state = rowToBucket(rows[0] as Record<string, unknown> | undefined, now);
    return state ? { tokens: state.tokens, updatedAt: state.updatedAt, now } : { now };
  }

  resetRateLimit(key: string): Promise<void> {
    return this.driver.run(this.limits.deleteBucket, [key]);
  }

  async rateLimitKeys(opts: KeysQuery): Promise<string[]> {
    const limit = clampKeysLimit(opts.limit);
    if (limit === 0) return [];
    const rows = await this.driver.read(this.limits.listBucketKeys(limit), [
      likePrefix(opts.prefix),
      this.clock.now(),
    ]);
    return rows.map((row) => String((row as Record<string, unknown>).key));
  }
}
