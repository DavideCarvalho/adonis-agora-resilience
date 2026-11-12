import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resilienceDoctorChecks } from '../../src/doctor/checks.js';
import {
  type BreakerConfig,
  ensureResilienceSchema,
  type LucidDatabase,
  lucidResilienceStore,
  ResilienceService,
} from '../../src/index.js';
import type { LucidQueryClient } from '../../src/stores/lucid.js';

const cfg: BreakerConfig = { threshold: 2, cooldownMs: 60_000 };
const TABLE = /resilience_(?:circuits|bulkhead_leases|rate_limits)/g;

function makeDatabase(): Database {
  const url = process.env.RESILIENCE_TEST_PG_URL;
  if (!url) throw new Error('RESILIENCE_TEST_PG_URL is unset — run test:integration');
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as never;
  // No searchPath: the connection's default schema stays `public`.
  return new Database(
    {
      connection: 'pg',
      connections: { pg: { client: 'pg', connection: url, pool: { min: 0, max: 4 } } },
    },
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

/** Every mention of a resilience table in `sql` that is not `"schema"."table"`. */
function unqualified(sql: string, schema: string): string[] {
  const bad: string[] = [];
  for (const match of sql.matchAll(TABLE)) {
    const before = sql.slice(0, match.index);
    if (!before.endsWith(`"${schema}"."`)) bad.push(match[0]);
  }
  return bad;
}

async function tablesIn(db: Database, schema: string): Promise<string[]> {
  const result = (await db.rawQuery(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'resilience_%' ORDER BY table_name",
    [schema],
  )) as { rows: { table_name: string }[] };
  return result.rows.map((r) => r.table_name);
}

describe('Lucid store on Postgres with `schema`', () => {
  let db: Database;
  let schema: string;

  beforeEach(async (context) => {
    db = makeDatabase();
    schema = `res_${context.task.id.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.rawQuery(
      'DROP TABLE IF EXISTS resilience_circuits, resilience_bulkhead_leases, resilience_rate_limits',
    );
  });

  afterEach(async () => {
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
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
    expect(await tablesIn(db, 'public')).toEqual([]);
    expect(log.some((sql) => sql.startsWith(`CREATE SCHEMA IF NOT EXISTS "${schema}"`))).toBe(true);
    expect(log.flatMap((sql) => unqualified(sql, schema))).toEqual([]);
    expect(log.some((sql) => /search_path/i.test(sql))).toBe(false);
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
    await expect(store.snapshot('x')).rejects.toThrow(/does not exist/);
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
    const rows = (await db.rawQuery(
      `SELECT COUNT(*) AS n FROM "${schema}".resilience_circuits`,
    )) as {
      rows: { n: string }[];
    };
    expect(Number(rows.rows[0]?.n)).toBe(0);

    await db.rawQuery(`DROP TABLE "${schema}".resilience_rate_limits`);
    expect((await store.inspectSchema())?.missingTables).toEqual(['resilience_rate_limits']);
  });

  it('the doctor reports the schema, its tables and that it can write', async () => {
    const lucid = db as unknown as LucidDatabase;
    const store = lucidResilienceStore(lucid, { schema });
    await store.snapshot('x');
    const service = new ResilienceService({ emit: false, store });
    const app = {
      container: { make: async () => service },
      config: { get: () => ({}) },
    } as never;
    const check = resilienceDoctorChecks().find((c) => c.id === 'resilience.store-reachable');
    const ok = await check?.run(app);
    expect(ok).toEqual([
      { status: 'ok', message: `default answers (tables in schema "${schema}", writable)` },
    ]);

    await db.rawQuery(`DROP TABLE "${schema}".resilience_circuits`);
    const bad = (await check?.run(app)) as { status: string; message: string }[];
    expect(bad[0]?.status).toBe('error');
    expect(bad[0]?.message).toContain('resilience_circuits not in schema');
    expect((bad[0] as { fix?: string }).fix).toMatch(/^Create the schema and tables/);
  });

  it('a role that cannot create the schema gets a message naming it and the grant', async () => {
    const role = `res_ro_${Date.now()}`;
    await db.rawQuery(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
    const url = new URL(process.env.RESILIENCE_TEST_PG_URL as string);
    url.username = role;
    url.password = 'pw';
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as never;
    const limited = new Database(
      { connection: 'pg', connections: { pg: { client: 'pg', connection: url.toString() } } },
      new LoggerFactory().create(),
      new Emitter(app),
    );
    try {
      // A new role has no CREATE on the database (PUBLIC gets only CONNECT and TEMP).
      const store = lucidResilienceStore(limited as unknown as LucidDatabase, { schema });
      await expect(store.snapshot('x')).rejects.toThrow(
        new RegExp(`could not create the schema "${schema}".*GRANT CREATE ON DATABASE`),
      );
    } finally {
      await limited.manager.closeAll();
      await db.rawQuery(`DROP ROLE ${role}`);
    }
  });
});

describe('Lucid store on Postgres without `schema`', () => {
  it('keeps the unqualified names in the current schema', async () => {
    const db = makeDatabase();
    try {
      await db.rawQuery(
        'DROP TABLE IF EXISTS resilience_circuits, resilience_bulkhead_leases, resilience_rate_limits',
      );
      const log: string[] = [];
      const store = lucidResilienceStore(recording(db, log));
      await store.record('k', cfg, false, false);
      expect(await tablesIn(db, 'public')).toHaveLength(3);
      expect(log.some((sql) => sql.includes('"'))).toBe(false);
      expect(await store.inspectSchema()).toBeUndefined();
    } finally {
      await db.rawQuery(
        'DROP TABLE IF EXISTS resilience_circuits, resilience_bulkhead_leases, resilience_rate_limits',
      );
      await db.manager.closeAll();
    }
  });
});
