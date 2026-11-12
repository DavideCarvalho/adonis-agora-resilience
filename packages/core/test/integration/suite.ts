import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resilienceDoctorChecks } from '../../src/doctor/checks.js';
import {
  type BreakerConfig,
  ensureResilienceSchema,
  type LucidDatabase,
  lucidResilienceStore,
  ResilienceService,
} from '../../src/index.js';
import type { LucidQueryClient } from '../../src/stores/lucid.js';
import {
  runBulkheadStoreContract,
  runRateLimitStoreContract,
  runResilienceStoreContract,
} from '../../src/testing.js';

/** One database server the suite runs against. */
export interface Target {
  name: 'Postgres' | 'MySQL';
  /** A Lucid database on the server's default schema (Postgres `public`, MySQL the default db). */
  makeDatabase(credentials?: { user: string; password: string }): Database;
  /** The connection's own schema, which must stay empty when `schema` is set. */
  defaultSchema: string;
  quote(identifier: string): string;
  dropSchema(name: string): string;
  /** The statement auto-create starts with. */
  createSchema: string;
  /** Rows of a `rawQuery` result. */
  rows(result: unknown): Record<string, unknown>[];
  /** A login that cannot create schemas, and how to remove it. */
  createLimitedUser(
    db: Database,
  ): Promise<{ user: string; password: string; drop(): Promise<void> }>;
  /** The grant the error names when the schema cannot be created. */
  grant: RegExp;
  /** The driver's "table does not exist" message. */
  missingTable: RegExp;
}

const cfg: BreakerConfig = { threshold: 2, cooldownMs: 60_000 };
const TABLE = /resilience_(?:circuits|bulkhead_leases|rate_limits)/g;
const TABLES = 'resilience_circuits, resilience_bulkhead_leases, resilience_rate_limits';

export function lucidDatabase(config: Record<string, unknown>): Database {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as never;
  return new Database(
    { connection: 'c', connections: { c: { pool: { min: 0, max: 6 }, ...config } as never } },
    new LoggerFactory().create(),
    new Emitter(app),
  );
}

/** Records every SQL statement the store sends, on the client and inside its transactions. */
function recording(db: Database, log: string[]): LucidDatabase {
  const wrap = (client: LucidQueryClient): LucidQueryClient => ({
    dialect: client.dialect,
    rawQuery: (sql, bindings) => {
      log.push(sql);
      return client.rawQuery(sql, bindings);
    },
  });
  const lucid = db as unknown as LucidDatabase;
  return {
    ...wrap(db.connection() as unknown as LucidQueryClient),
    connection: () => db.connection(),
    transaction: (cb) => lucid.transaction((trx) => cb(wrap(trx))),
  };
}

export function runIntegrationSuite(target: Target): void {
  const { quote: q } = target;

  /** Every mention of a resilience table in `sql` that is not `schema.table`. */
  const unqualified = (sql: string, schema: string): string[] => {
    const bad: string[] = [];
    for (const match of sql.matchAll(TABLE)) {
      const before = sql.slice(0, match.index);
      if (!before.endsWith(`${q(schema)}.${q('').slice(0, 1)}`)) bad.push(match[0]);
    }
    return bad;
  };

  const tablesIn = async (db: Database, schema: string): Promise<string[]> =>
    target
      .rows(
        await db.rawQuery(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'resilience_%' ORDER BY table_name",
          [schema],
        ),
      )
      .map((r) => String(r.name));

  describe(`Lucid store on ${target.name} with \`schema\``, () => {
    let db: Database;
    let schema: string;

    beforeEach(async (context) => {
      db = target.makeDatabase();
      schema = `res_${context.task.id.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
      await db.rawQuery(target.dropSchema(schema));
      await db.rawQuery(`DROP TABLE IF EXISTS ${TABLES}`);
    });

    afterEach(async () => {
      await db.rawQuery(target.dropSchema(schema));
      await db.manager.closeAll();
    });

    it('creates the schema and tables there, and never names a table unqualified', async () => {
      const log: string[] = [];
      const store = lucidResilienceStore(recording(db, log), { schema });

      // circuits: record, admit, snapshot, keys, reset
      await store.record('payments', cfg, false, false);
      await store.record('payments', cfg, false, false);
      expect((await store.snapshot('payments')).status).toBe('open');
      expect((await store.admit('payments', cfg)).allow).toBe(false);
      await store.record('payments', cfg, true, false);
      expect(await store.keys({ prefix: 'pay', limit: 10 })).toEqual(['payments']);
      await store.reset('payments');
      expect(await store.snapshot('payments')).toEqual({ status: 'closed', failures: 0 });

      // bulkheads
      const lease = await store.acquireBulkhead('pool', { limit: 1, leaseMs: 60_000 });
      expect(lease.acquired).toBe(true);
      expect((await store.acquireBulkhead('pool', { limit: 1, leaseMs: 60_000 })).acquired).toBe(
        false,
      );
      expect(await store.bulkheadSnapshot('pool')).toEqual({ active: 1 });
      expect(await store.bulkheadKeys({ prefix: '', limit: 10 })).toEqual(['pool']);
      if (lease.acquired) await store.releaseBulkhead('pool', lease.leaseId);
      await store.resetBulkhead('pool');

      // rate limiters
      const rl = { limit: 2, intervalMs: 60_000 };
      expect((await store.consumeRateLimit('api', rl, 1)).allowed).toBe(true);
      expect((await store.rateLimitSnapshot('api')).tokens).toBe(1);
      expect(await store.rateLimitKeys({ prefix: 'a', limit: 10 })).toEqual(['api']);
      await store.resetRateLimit('api');

      expect(await tablesIn(db, schema)).toEqual([
        'resilience_bulkhead_leases',
        'resilience_circuits',
        'resilience_rate_limits',
      ]);
      expect(await tablesIn(db, target.defaultSchema)).toEqual([]);
      expect(log.some((sql) => sql.startsWith(`${target.createSchema} ${q(schema)}`))).toBe(true);
      expect(log.flatMap((sql) => unqualified(sql, schema))).toEqual([]);
      expect(log.some((sql) => /search_path/i.test(sql))).toBe(false);
    });

    it('keeps keys that differ only in case or accents apart', async () => {
      const store = lucidResilienceStore(db as unknown as LucidDatabase, { schema });
      await store.record('Key', cfg, false, false);
      await store.record('key', cfg, false, false);
      await store.record('kéy', cfg, false, false);
      expect((await store.snapshot('Key')).failures).toBe(1);
      expect((await store.snapshot('key')).failures).toBe(1);
      expect(await store.keys({ prefix: 'K', limit: 10 })).toEqual(['Key']);
    });

    it('boots idempotently, including two stores racing to create the schema', async () => {
      const a = lucidResilienceStore(db as unknown as LucidDatabase, { schema });
      const b = lucidResilienceStore(db as unknown as LucidDatabase, { schema });
      await Promise.all([a.snapshot('x'), b.snapshot('x')]);
      await ensureResilienceSchema(db as unknown as LucidDatabase, { schema });
      await ensureResilienceSchema(db as unknown as LucidDatabase, { schema });
      expect(await tablesIn(db, schema)).toHaveLength(3);
    });

    it('runs inside the app transaction and rolls back with it', async () => {
      await ensureResilienceSchema(db as unknown as LucidDatabase, { schema });
      const trx = await db.transaction();
      const inTrx = lucidResilienceStore(trx as unknown as LucidDatabase, {
        schema,
        autoCreateSchema: false,
      });
      await inTrx.record('t', cfg, false, false);
      expect((await inTrx.snapshot('t')).failures).toBe(1);
      await trx.rollback();

      const store = lucidResilienceStore(db as unknown as LucidDatabase, {
        schema,
        autoCreateSchema: false,
      });
      expect((await store.snapshot('t')).failures).toBe(0);

      await db.transaction(async (committed) => {
        const s = lucidResilienceStore(committed as unknown as LucidDatabase, {
          schema,
          autoCreateSchema: false,
        });
        await s.record('t', cfg, false, false);
      });
      expect((await store.snapshot('t')).failures).toBe(1);
    });

    it('with autoCreateSchema off, does not create anything and fails on the missing table', async () => {
      const store = lucidResilienceStore(db as unknown as LucidDatabase, {
        schema,
        autoCreateSchema: false,
      });
      await expect(store.snapshot('x')).rejects.toThrow(target.missingTable);
      const report = await store.inspectSchema();
      expect(report).toEqual({
        schema,
        exists: false,
        missingTables: expect.any(Array),
        writable: false,
      });
      expect(report?.missingTables).toHaveLength(3);
    });

    it('inspectSchema: exists, tables there, writable — and the write probe leaves no row', async () => {
      const store = lucidResilienceStore(db as unknown as LucidDatabase, { schema });
      await store.snapshot('x');
      expect(await store.inspectSchema()).toEqual({
        schema,
        exists: true,
        missingTables: [],
        writable: true,
      });
      const rows = target.rows(
        await db.rawQuery(`SELECT COUNT(*) AS n FROM ${q(schema)}.resilience_circuits`),
      );
      expect(Number(rows[0]?.n)).toBe(0);

      await db.rawQuery(`DROP TABLE ${q(schema)}.resilience_rate_limits`);
      expect((await store.inspectSchema())?.missingTables).toEqual(['resilience_rate_limits']);
    });

    it('the doctor reports the schema, its tables and that it can write', async () => {
      const store = lucidResilienceStore(db as unknown as LucidDatabase, { schema });
      await store.snapshot('x');
      const service = new ResilienceService({ emit: false, store });
      const app = {
        container: { make: async () => service },
        config: { get: () => ({}) },
      } as never;
      const check = resilienceDoctorChecks().find((c) => c.id === 'resilience.store-reachable');
      expect(await check?.run(app)).toEqual([
        { status: 'ok', message: `default answers (tables in schema "${schema}", writable)` },
      ]);

      await db.rawQuery(`DROP TABLE ${q(schema)}.resilience_circuits`);
      const bad = (await check?.run(app)) as { status: string; message: string; fix?: string }[];
      expect(bad[0]?.status).toBe('error');
      expect(bad[0]?.message).toContain('resilience_circuits not in schema');
      expect(bad[0]?.fix).toMatch(/^Create the schema and tables/);
    });

    it('a login that cannot create the schema gets a message naming it and the grant', async () => {
      const login = await target.createLimitedUser(db);
      const limited = target.makeDatabase(login);
      try {
        const store = lucidResilienceStore(limited as unknown as LucidDatabase, { schema });
        await expect(store.snapshot('x')).rejects.toThrow(
          new RegExp(`could not create the (schema|database) "${schema}".*${target.grant.source}`),
        );
      } finally {
        await limited.manager.closeAll();
        await login.drop();
      }
    });
  });

  describe(`Lucid store on ${target.name} without \`schema\``, () => {
    it('keeps the unqualified names in the current schema', async () => {
      const db = target.makeDatabase();
      try {
        await db.rawQuery(`DROP TABLE IF EXISTS ${TABLES}`);
        const log: string[] = [];
        const store = lucidResilienceStore(recording(db, log));
        await store.record('k', cfg, false, false);
        await store.consumeRateLimit('r', { limit: 1, intervalMs: 1000 }, 1);
        await store.acquireBulkhead('b', { limit: 1, leaseMs: 1000 });
        expect(await tablesIn(db, target.defaultSchema)).toHaveLength(3);
        expect(log.some((sql) => /[."`]resilience_/.test(sql))).toBe(false);
        expect(await store.inspectSchema()).toBeUndefined();
      } finally {
        await db.rawQuery(`DROP TABLE IF EXISTS ${TABLES}`);
        await db.manager.closeAll();
      }
    });
  });

  // The store contracts (incl. concurrent probes, slots and buckets), each case in its own schema.
  describe(`store contracts on ${target.name}`, () => {
    const db = target.makeDatabase();
    const schemas: string[] = [];
    let n = 0;
    const make = (clock: Parameters<Parameters<typeof runResilienceStoreContract>[1]>[0]) => {
      const schema = `res_contract_${process.pid}_${n++}`;
      schemas.push(schema);
      return lucidResilienceStore(db as unknown as LucidDatabase, { schema, clock });
    };
    afterAll(async () => {
      for (const schema of schemas) await db.rawQuery(target.dropSchema(schema));
      await db.manager.closeAll();
    });
    runResilienceStoreContract(`Lucid on ${target.name}`, make);
    runBulkheadStoreContract(`Lucid on ${target.name}`, make);
    runRateLimitStoreContract(`Lucid on ${target.name}`, make);
  });
}
