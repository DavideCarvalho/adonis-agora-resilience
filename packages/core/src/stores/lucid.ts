import {
  CIRCUITS_DDL,
  type SqlDriver,
  SqlResilienceStore,
  type SqlResilienceStoreOptions,
  type SqlTx,
} from '../breaker/sql.js';
import type { ResilienceStore } from '../breaker/store.js';

/**
 * The slice of a Lucid query/transaction client this store relies on. Both the root `Database`
 * instance and a `TransactionClientContract` satisfy it, so we depend on the surface rather than
 * on a concrete Lucid type — keeping the peer-dependency coupling minimal.
 */
export interface LucidQueryClient {
  rawQuery(sql: string, bindings?: readonly unknown[]): Promise<unknown>;
}

/**
 * The slice of a Lucid `Database` this store needs: a query client (via {@link LucidQueryClient})
 * plus the `transaction()` runner used for the breaker's atomic load→compute→persist cycle.
 * `connection()` is optional and used only to auto-detect the dialect.
 */
export interface LucidDatabase extends LucidQueryClient {
  transaction<T>(callback: (trx: LucidQueryClient) => Promise<T>): Promise<T>;
  connection?(name?: string): { dialect?: { name?: string } };
}

/**
 * Whether the breaker's pessimistic `SELECT … FOR UPDATE` lock is supported. SQLite serialises
 * writers at the transaction level and rejects `FOR UPDATE` syntax, so it is stripped there; the
 * single-writer model still satisfies the store's atomicity contract.
 */
function dialectSupportsForUpdate(dialect: string | undefined): boolean {
  if (!dialect) return true;
  return !/sqlite/i.test(dialect);
}

/** Best-effort read of the default connection's dialect name; `undefined` if unavailable. */
function detectDialect(db: LucidDatabase): string | undefined {
  try {
    return db.connection?.()?.dialect?.name;
  } catch {
    return undefined;
  }
}

/**
 * Lucid `rawQuery` returns the underlying driver result. For SELECTs on the sqlite/mysql dialects
 * that is the row array directly; Postgres returns a `{ rows }` object. Normalise to a plain row
 * array so the agnostic {@link SqlResilienceStore} always receives `unknown[]`.
 *
 * Only the breaker's SELECTs flow through here (writes discard their result), and they match a single
 * circuit by primary key — so 0 or 1 rows. An unrecognised driver shape therefore degrades to `[]`,
 * which the store reads as "no row yet" → a fresh closed circuit. That is the intended fail-OPEN: a
 * storage-read quirk lets traffic through rather than wedging the breaker shut. The DDL pins the four
 * columns, so an unexpected shape here means a driver change, not a schema mismatch.
 */
function toRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

/**
 * Build the agnostic {@link SqlDriver} over a Lucid client. Lucid uses `?` positional placeholders on
 * its sqlite and mysql dialects, so the breaker SQL uses the `positional` style. Transactions go
 * through Lucid's `db.transaction()`, which the breaker's `FOR UPDATE` locking relies on for
 * atomicity on databases that support row locks. The `lockRows` capability is passed straight
 * through to core, which generates the locking read with or without `FOR UPDATE` accordingly — this
 * adapter never rewrites SQL.
 */
function lucidDriver(db: LucidDatabase, supportsForUpdate: boolean): SqlDriver {
  const tx = (client: LucidQueryClient): SqlTx => ({
    run: async (sql, params) => {
      await client.rawQuery(sql, params);
    },
    all: async (sql, params) => toRows(await client.rawQuery(sql, params)),
  });

  return {
    placeholders: 'positional',
    lockRows: supportsForUpdate,
    transaction: (body) => db.transaction((trx) => body(tx(trx))),
    read: async (sql, params) => toRows(await db.rawQuery(sql, params)),
    run: async (sql, params) => {
      await db.rawQuery(sql, params);
    },
    exec: async (sql) => {
      await db.rawQuery(sql);
    },
  };
}

export interface LucidResilienceStoreOptions extends SqlResilienceStoreOptions {
  /**
   * When `true` (the default), the circuit table is created on first use via the idempotent
   * {@link CIRCUITS_DDL}. Set to `false` if you manage the schema with an Adonis migration and want
   * to skip the runtime `CREATE TABLE IF NOT EXISTS`.
   */
  autoCreateSchema?: boolean;
  /**
   * Force whether `SELECT … FOR UPDATE` row locks are used. By default the dialect is auto-detected
   * (stripped for SQLite, kept for Postgres/MySQL). Override only if auto-detection is unavailable.
   */
  useRowLocks?: boolean;
}

/**
 * SQL-backed {@link ResilienceStore} powered by AdonisJS Lucid. A thin {@link SqlDriver} over a
 * Lucid `Database` feeds the agnostic {@link SqlResilienceStore}, so all breaker semantics stay in
 * core and this adapter only bridges to Lucid.
 *
 * Unless disabled via `autoCreateSchema: false`, the circuit table is lazily created exactly once
 * before the first operation, so wiring `stores.lucid()` needs no extra setup.
 */
export class LucidResilienceStore extends SqlResilienceStore {
  private readonly autoCreateSchema: boolean;
  private schemaReady?: Promise<void>;

  constructor(db: LucidDatabase, opts: LucidResilienceStoreOptions = {}) {
    const supportsForUpdate = opts.useRowLocks ?? dialectSupportsForUpdate(detectDialect(db));
    super(lucidDriver(db, supportsForUpdate), opts);
    this.autoCreateSchema = opts.autoCreateSchema ?? true;
  }

  /** Ensure the table exists exactly once; concurrent callers share the same in-flight promise. */
  private ready(): Promise<void> {
    if (!this.autoCreateSchema) return Promise.resolve();
    if (!this.schemaReady) this.schemaReady = this.ensureSchema();
    return this.schemaReady;
  }

  override async admit(...args: Parameters<SqlResilienceStore['admit']>) {
    await this.ready();
    return super.admit(...args);
  }

  override async record(...args: Parameters<SqlResilienceStore['record']>) {
    await this.ready();
    return super.record(...args);
  }

  override async snapshot(...args: Parameters<SqlResilienceStore['snapshot']>) {
    await this.ready();
    return super.snapshot(...args);
  }

  override async reset(...args: Parameters<SqlResilienceStore['reset']>) {
    await this.ready();
    return super.reset(...args);
  }
}

/**
 * Factory for a Lucid-backed {@link ResilienceStore}. Usually you don't call this directly:
 * `config/resilience.ts` selects it via `stores.lucid({ ... })` and the provider builds it for you.
 */
export function lucidResilienceStore(
  db: LucidDatabase,
  opts: LucidResilienceStoreOptions = {},
): ResilienceStore {
  return new LucidResilienceStore(db, opts);
}

/**
 * Run the circuit table DDL on the given Lucid client. Idempotent (`CREATE TABLE IF NOT EXISTS`),
 * so it is safe to call on every boot. Prefer a real Adonis migration in production; this helper
 * is handy for tests and quick setups. See {@link CIRCUITS_DDL} for use in migrations.
 */
export async function ensureResilienceSchema(db: LucidQueryClient): Promise<void> {
  await db.rawQuery(CIRCUITS_DDL);
}
