import { afterEach, describe, expect, it } from 'vitest';
import {
  CIRCUITS_DDL,
  ensureResilienceSchema,
  lucidResilienceStore,
  RESILIENCE_DDL,
  resilienceDdl,
  resilienceTableNames,
} from '../src/index.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid-helpers.js';

describe('schema option', () => {
  const open: { manager: { closeAll(): Promise<void> } }[] = [];
  afterEach(async () => {
    for (const db of open.splice(0)) await db.manager.closeAll();
  });

  it('leaves table names and the exported DDL unqualified without a schema', () => {
    expect(resilienceTableNames()).toEqual({
      circuits: 'resilience_circuits',
      bulkheadLeases: 'resilience_bulkhead_leases',
      rateLimits: 'resilience_rate_limits',
    });
    expect(resilienceDdl()).toEqual([...RESILIENCE_DDL]);
    expect(CIRCUITS_DDL).toContain('CREATE TABLE IF NOT EXISTS resilience_circuits (');
  });

  it('quotes schema and table separately', () => {
    expect(resilienceTableNames({ schema: 'resilience' }).circuits).toBe(
      '"resilience"."resilience_circuits"',
    );
    expect(resilienceTableNames({ schema: 'ops', quote: 'backtick' }).rateLimits).toBe(
      '`ops`.`resilience_rate_limits`',
    );
  });

  it('creates the schema before the tables', () => {
    const ddl = resilienceDdl({ schema: 'resilience' });
    expect(ddl[0]).toBe('CREATE SCHEMA IF NOT EXISTS "resilience"');
    expect(ddl.slice(1).every((s) => s.includes('"resilience"."resilience_'))).toBe(true);
    expect(resilienceDdl({ schema: 'ops', quote: 'backtick' })[0]).toBe(
      'CREATE DATABASE IF NOT EXISTS `ops`',
    );
  });

  it.each([['1abc'], ['has space'], ['a"b'], ['a.b'], [''], ['x'.repeat(64)]])(
    'rejects the schema name %j',
    (schema) => {
      expect(() => resilienceTableNames({ schema })).toThrow(/invalid schema/);
    },
  );

  it('accepts a 63-character name with $', () => {
    expect(() => resilienceTableNames({ schema: `a$${'b'.repeat(61)}` })).not.toThrow();
  });

  it('fails on SQLite instead of ignoring the schema', async () => {
    const db = makeMemoryDatabase();
    open.push(db);
    expect(() => lucidResilienceStore(asLucidDatabase(db), { schema: 'resilience' })).toThrow(
      /needs Postgres or MySQL; SQLite has no schemas/,
    );
    await expect(
      ensureResilienceSchema(asLucidDatabase(db), { schema: 'resilience' }),
    ).rejects.toThrow(/SQLite has no schemas/);
  });

  it('rejects an invalid name when the store is built', () => {
    const db = makeMemoryDatabase();
    open.push(db);
    expect(() => lucidResilienceStore(asLucidDatabase(db), { schema: 'bad name' })).toThrow(
      /invalid schema/,
    );
  });

  it('reports no schema without one', async () => {
    const db = makeMemoryDatabase();
    open.push(db);
    expect(await lucidResilienceStore(asLucidDatabase(db)).inspectSchema()).toBeUndefined();
  });
});
