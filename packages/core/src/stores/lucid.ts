import {
  assertSchemaName,
  type ResilienceSchemaOptions,
  resilienceDdl,
  type SqlDriver,
  type SqlIdentifierQuote,
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
  /** Present on a Lucid query or transaction client; used to detect the dialect. */
  dialect?: { name?: string };
}

/**
 * The slice of a Lucid `Database` this store needs: a query client (via {@link LucidQueryClient})
 * plus the `transaction()` runner used for the breaker's atomic load→compute→persist cycle.
 * `connection()` (on the root `Database`) or `dialect` (on a query/transaction client) is optional and
 * used only to auto-detect the dialect.
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

/**
 * Best-effort read of the client's dialect name (a query/transaction client carries `dialect`, the
 * root `Database` exposes it through its default connection); `undefined` if unavailable.
 */
function detectDialect(
  db: LucidQueryClient & Pick<LucidDatabase, 'connection'>,
): string | undefined {
  try {
    return db.dialect?.name ?? db.connection?.()?.dialect?.name;
  } catch {
    return undefined;
  }
}

function identifierQuoteOf(dialect: string | undefined): SqlIdentifierQuote {
  return dialect !== undefined && /mysql|maria/i.test(dialect) ? 'backtick' : 'double';
}

/**
 * Checks a `schema` against the dialect: a valid identifier, and a dialect that has schemas (SQLite
 * does not, and the store never falls back to unqualified names).
 */
function assertSchemaSupported(schema: string | undefined, dialect: string | undefined): void {
  if (schema === undefined) return;
  assertSchemaName(schema);
  if (dialect !== undefined && /sqlite/i.test(dialect)) {
    throw new Error(
      `@adonis-agora/resilience: \`schema: "${schema}"\` needs Postgres or MySQL; SQLite has no ` +
        'schemas. Remove `schema` from the Lucid store, or point it at a Postgres/MySQL connection.',
    );
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
function lucidDriver(
  db: LucidDatabase,
  supportsForUpdate: boolean,
  identifierQuote: SqlIdentifierQuote,
): SqlDriver {
  const tx = (client: LucidQueryClient): SqlTx => ({
    run: async (sql, params) => {
      await client.rawQuery(sql, params);
    },
    all: async (sql, params) => toRows(await client.rawQuery(sql, params)),
  });

  return {
    placeholders: 'positional',
    lockRows: supportsForUpdate,
    identifierQuote,
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
   * When `true` (the default), the tables (and the `schema`, when set and missing) are created on
   * first use via the idempotent {@link resilienceDdl}. Set to `false` if you manage them with an
   * Adonis migration and want to skip the runtime `CREATE TABLE IF NOT EXISTS`.
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
  private schemaReady: Promise<void> | undefined;

  constructor(db: LucidDatabase, opts: LucidResilienceStoreOptions = {}) {
    const dialect = detectDialect(db);
    assertSchemaSupported(opts.schema, dialect);
    const supportsForUpdate = opts.useRowLocks ?? dialectSupportsForUpdate(dialect);
    super(lucidDriver(db, supportsForUpdate, identifierQuoteOf(dialect)), opts);
    this.autoCreateSchema = opts.autoCreateSchema ?? true;
  }

  /** Ensure the table exists exactly once; concurrent callers share the same in-flight promise. */
  private ready(): Promise<void> {
    if (!this.autoCreateSchema) return Promise.resolve();
    if (!this.schemaReady) {
      // A failed attempt (database down, missing grant) is retried on the next call.
      this.schemaReady = this.ensureSchema().catch((error: unknown) => {
        this.schemaReady = undefined;
        throw error;
      });
    }
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

  override async keys(...args: Parameters<SqlResilienceStore['keys']>) {
    await this.ready();
    return super.keys(...args);
  }

  override async acquireBulkhead(...args: Parameters<SqlResilienceStore['acquireBulkhead']>) {
    await this.ready();
    return super.acquireBulkhead(...args);
  }

  override async releaseBulkhead(...args: Parameters<SqlResilienceStore['releaseBulkhead']>) {
    await this.ready();
    return super.releaseBulkhead(...args);
  }

  override async bulkheadSnapshot(...args: Parameters<SqlResilienceStore['bulkheadSnapshot']>) {
    await this.ready();
    return super.bulkheadSnapshot(...args);
  }

  override async resetBulkhead(...args: Parameters<SqlResilienceStore['resetBulkhead']>) {
    await this.ready();
    return super.resetBulkhead(...args);
  }

  override async bulkheadKeys(...args: Parameters<SqlResilienceStore['bulkheadKeys']>) {
    await this.ready();
    return super.bulkheadKeys(...args);
  }

  override async consumeRateLimit(...args: Parameters<SqlResilienceStore['consumeRateLimit']>) {
    await this.ready();
    return super.consumeRateLimit(...args);
  }

  override async rateLimitSnapshot(...args: Parameters<SqlResilienceStore['rateLimitSnapshot']>) {
    await this.ready();
    return super.rateLimitSnapshot(...args);
  }

  override async resetRateLimit(...args: Parameters<SqlResilienceStore['resetRateLimit']>) {
    await this.ready();
    return super.resetRateLimit(...args);
  }

  override async rateLimitKeys(...args: Parameters<SqlResilienceStore['rateLimitKeys']>) {
    await this.ready();
    return super.rateLimitKeys(...args);
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
): LucidResilienceStore {
  return new LucidResilienceStore(db, opts);
}

/**
 * Run the tables' DDL on the given Lucid client (a `Database`, a connection or a transaction).
 * Idempotent (`CREATE … IF NOT EXISTS`), so it is safe to call on every boot. With `schema`, the
 * schema (MySQL: database) is created too and every table lands in it. Prefer a real Adonis migration
 * in production; this helper is handy for tests and quick setups. See {@link resilienceDdl}.
 */
export async function ensureResilienceSchema(
  db: LucidQueryClient & Pick<LucidDatabase, 'connection'>,
  opts: Pick<ResilienceSchemaOptions, 'schema'> = {},
): Promise<void> {
  const dialect = detectDialect(db);
  assertSchemaSupported(opts.schema, dialect);
  for (const ddl of resilienceDdl({ schema: opts.schema, quote: identifierQuoteOf(dialect) })) {
    await db.rawQuery(ddl);
  }
}
