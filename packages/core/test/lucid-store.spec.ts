import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BreakerConfig } from '../src/index.js';
import {
  ensureResilienceSchema,
  InMemoryResilienceStore,
  lucidResilienceStore,
} from '../src/index.js';
import { ResilienceService } from '../src/resilience_service.js';
import type { LucidDatabase, LucidQueryClient } from '../src/stores/lucid.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid-helpers.js';

const cfg: BreakerConfig = { threshold: 3, cooldownMs: 1000 };

describe('LucidResilienceStore', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('returns the closed default for a never-seen key', async () => {
    const store = lucidResilienceStore(asLucidDatabase(db));
    expect(await store.snapshot('nope')).toEqual({ status: 'closed', failures: 0 });
  });

  it('runs the DDL idempotently (safe to call repeatedly)', async () => {
    const lucid = asLucidDatabase(db);
    await ensureResilienceSchema(lucid);
    await ensureResilienceSchema(lucid);
    await ensureResilienceSchema(lucid);
    const store = lucidResilienceStore(lucid);
    await store.record('k', cfg, false, false);
    expect((await store.snapshot('k')).failures).toBe(1);
  });

  it('persists state across separate store instances on the same connection', async () => {
    const lucid = asLucidDatabase(db);
    const first = lucidResilienceStore(lucid);
    for (let i = 0; i < 3; i++) await first.record('shared', cfg, false, false);
    expect((await first.snapshot('shared')).status).toBe('open');

    // A brand-new store backed by the same connection sees the persisted open state.
    const second = lucidResilienceStore(lucid);
    expect((await second.snapshot('shared')).status).toBe('open');
    expect((await second.admit('shared', cfg)).allow).toBe(false);
  });

  it('skips runtime DDL when autoCreateSchema is false (table must pre-exist)', async () => {
    const lucid = asLucidDatabase(db);
    await ensureResilienceSchema(lucid);
    const store = lucidResilienceStore(lucid, { autoCreateSchema: false });
    await store.record('k', cfg, false, false);
    expect((await store.snapshot('k')).failures).toBe(1);
  });

  it('runs a successful call on a closed circuit without a transaction or a row write', async () => {
    const lucid = asLucidDatabase(db);
    await ensureResilienceSchema(lucid);
    const counts = { transactions: 0, queries: 0 };
    const counted = (client: LucidQueryClient): LucidQueryClient => ({
      rawQuery: (sql, bindings) => {
        counts.queries += 1;
        return client.rawQuery(sql, bindings);
      },
    });
    const wrapped: LucidDatabase = {
      ...counted(lucid),
      transaction: (cb) =>
        lucid.transaction((trx) => {
          counts.transactions += 1;
          return cb(counted(trx));
        }),
    };
    const store = lucidResilienceStore(wrapped, { autoCreateSchema: false, useRowLocks: false });
    await store.record('k', cfg, false, false);
    await store.record('k', cfg, true, false);
    const changes = async () =>
      Number(((await db.rawQuery('SELECT total_changes() AS n')) as { n: number }[])[0]?.n);
    const changesBefore = await changes();
    counts.transactions = 0;
    counts.queries = 0;
    for (let i = 0; i < 5; i++) {
      const a = await store.admit('k', cfg);
      expect(a.allow).toBe(true);
      await store.record('k', cfg, true, a.probe);
    }
    expect(counts).toEqual({ transactions: 0, queries: 10 });
    expect(await changes()).toBe(changesBefore);
    const snapshot = await store.snapshot('k');
    expect(snapshot).toMatchObject({ status: 'closed', failures: 0 });
    // The failure stamped the row; the clean successes after it wrote nothing.
    expect(snapshot.createdAt).toBeInstanceOf(Date);
    expect(snapshot.updatedAt).toBeInstanceOf(Date);
  });
});

describe('circuit timestamps (Lucid, SQLite)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('adds created_at / updated_at to a table from before them; old rows keep NULL', async () => {
    // The circuits table as earlier versions created it.
    await db.rawQuery(`CREATE TABLE resilience_circuits (
      key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'closed', failures INTEGER NOT NULL DEFAULT 0,
      open_until BIGINT NOT NULL DEFAULT 0, probes INTEGER NOT NULL DEFAULT 0)`);
    await db.rawQuery(
      `INSERT INTO resilience_circuits (key, status, failures, open_until, probes) VALUES ('old', 'closed', 2, 0, 0)`,
    );

    const store = lucidResilienceStore(asLucidDatabase(db));
    expect(await store.snapshot('old')).toEqual({ status: 'closed', failures: 2 });

    const columns = (await db.rawQuery(`PRAGMA table_info(resilience_circuits)`)) as {
      name: string;
      notnull: number;
      dflt_value: unknown;
    }[];
    for (const name of ['created_at', 'updated_at']) {
      expect(columns.find((c) => c.name === name)).toMatchObject({ notnull: 0, dflt_value: null });
    }

    const before = Date.now();
    await store.record('new', cfg, false, false);
    const fresh = await store.snapshot('new');
    expect(fresh.createdAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(fresh.updatedAt?.getTime()).toBe(fresh.createdAt?.getTime());
  });

  it('the service lists circuits with ISO dates, and null where the store has none', async () => {
    const store = lucidResilienceStore(asLucidDatabase(db));
    await store.record('db', cfg, false, false);
    const service = new ResilienceService({ emit: false, store });
    const circuit = await service.getCircuit('db');
    expect(circuit.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(circuit.updatedAt).toBe(circuit.createdAt);

    const memory = new ResilienceService({ emit: false, store: new InMemoryResilienceStore() });
    expect(await memory.getCircuit('db')).toMatchObject({ createdAt: null, updatedAt: null });
  });
});
