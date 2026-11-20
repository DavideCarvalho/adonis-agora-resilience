import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock';
import { type SqlDriver, SqlResilienceStore, type SqlTx } from './sql';
import { runResilienceStoreContract } from './store_contract';
import type { BreakerConfig } from './types';

interface Row {
  status: string;
  failures: number;
  open_until: number;
  probes: number;
  created_at?: number | null;
  updated_at?: number | null;
}

/**
 * In-memory stand-in for a relational driver that understands exactly the breaker's statements.
 * Transactions are serialised (modelling the row lock), every statement yields to the event loop so
 * concurrent callers interleave, and each round trip, transaction and row write is counted.
 */
class FakeSqlDriver implements SqlDriver {
  readonly placeholders = 'numbered' as const;
  readonly rows = new Map<string, Row>();
  transactions = 0;
  roundTrips = 0;
  rowWrites = 0;
  private lock: Promise<void> = Promise.resolve();

  /** `legacy`: a circuits table from before `created_at` / `updated_at`. */
  constructor(private legacy = false) {}

  async run(sql: string, params: unknown[]): Promise<void> {
    await this.execute(sql, params);
  }

  async transaction<R>(body: (tx: SqlTx) => Promise<R>): Promise<R> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise((r) => {
      release = r;
    });
    await prev;
    this.transactions += 1;
    try {
      return await body({
        run: async (sql, params) => {
          await this.execute(sql, params);
        },
        all: (sql, params) => this.execute(sql, params),
      });
    } finally {
      release();
    }
  }

  read(sql: string, params: unknown[]): Promise<unknown[]> {
    return this.execute(sql, params);
  }

  readonly ddl: string[] = [];
  async exec(sql: string): Promise<void> {
    this.ddl.push(sql.trim());
    if (sql.includes('ADD COLUMN updated_at')) this.legacy = false;
  }

  private async execute(sql: string, params: unknown[]): Promise<unknown[]> {
    await new Promise((r) => setImmediate(r));
    this.roundTrips += 1;
    const text = sql.trim();
    if (text.includes('information_schema')) throw new Error('no such table: information_schema');
    if (text.includes('created_at') && this.legacy) throw new Error('no such column: created_at');
    if (text.includes('WHERE 1 = 0')) return [];
    if (text.startsWith('INSERT')) {
      const [key, created, updated] = params as [string, number?, number?];
      if (!this.rows.has(key)) {
        this.rows.set(key, {
          status: 'closed',
          failures: 0,
          open_until: 0,
          probes: 0,
          ...(created === undefined ? {} : { created_at: created, updated_at: updated ?? null }),
        });
        this.rowWrites += 1;
      }
      return [];
    }
    if (text.startsWith('DELETE')) {
      if (this.rows.delete(params[0] as string)) this.rowWrites += 1;
      return [];
    }
    if (text.startsWith('SELECT key')) {
      const limit = Number(/LIMIT (\d+)/.exec(text)?.[1]);
      const pattern = String(params[0]);
      const prefix = pattern.slice(0, -1).replace(/!(.)/g, '$1');
      return [...this.rows.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((key) => ({ key }));
    }
    if (text.startsWith('SELECT')) {
      const row = this.rows.get(params[0] as string);
      return row ? [{ ...row }] : [];
    }
    if (text.includes("status = 'closed'")) {
      const stamped = text.includes('updated_at');
      const row = this.rows.get((stamped ? params[1] : params[0]) as string);
      if (row && (row.status !== 'closed' || row.failures !== 0 || row.open_until !== 0)) {
        Object.assign(row, { status: 'closed', failures: 0, open_until: 0 });
        if (stamped) row.updated_at = params[0] as number;
        this.rowWrites += 1;
      }
      return [];
    }
    const stamped = params.length === 6;
    const [status, failures, open_until, probes] = params as [string, number, number, number];
    const key = params[stamped ? 5 : 4] as string;
    const row = this.rows.get(key);
    if (row) {
      Object.assign(row, { status, failures, open_until, probes });
      if (stamped) row.updated_at = params[4] as number;
      this.rowWrites += 1;
    }
    return [];
  }

  reset(): void {
    this.transactions = 0;
    this.roundTrips = 0;
    this.rowWrites = 0;
  }
}

const cfg: BreakerConfig = { threshold: 3, cooldownMs: 1000 };

runResilienceStoreContract(
  'SqlResilienceStore',
  (clock) => new SqlResilienceStore(new FakeSqlDriver(), { clock }),
);

describe('SqlResilienceStore round trips', () => {
  it('a successful call on a closed circuit takes no transaction and writes nothing', async () => {
    const driver = new FakeSqlDriver();
    const store = new SqlResilienceStore(driver, { clock: new FakeClock() });
    // Whether the table has the timestamp columns is probed once per store, not per call.
    await store.hasTimestampColumns();
    driver.reset();
    for (let i = 0; i < 5; i++) {
      const a = await store.admit('k', cfg);
      expect(a).toEqual({ allow: true, probe: false, status: 'closed' });
      expect(await store.record('k', cfg, true, a.probe)).toBe('closed');
    }
    expect(driver.transactions).toBe(0);
    expect(driver.roundTrips).toBe(10);
    expect(driver.rowWrites).toBe(0);
  });

  it('a success after failures writes the reset once', async () => {
    const driver = new FakeSqlDriver();
    const store = new SqlResilienceStore(driver, { clock: new FakeClock() });
    await store.record('k', cfg, false, false);
    driver.reset();
    await store.record('k', cfg, true, false);
    await store.record('k', cfg, true, false);
    expect(driver.transactions).toBe(0);
    expect(driver.rowWrites).toBe(1);
    expect(driver.rows.get('k')).toMatchObject({ status: 'closed', failures: 0 });
  });

  it('short-circuits an open circuit from a plain read', async () => {
    const driver = new FakeSqlDriver();
    const store = new SqlResilienceStore(driver, { clock: new FakeClock() });
    for (let i = 0; i < 3; i++) await store.record('k', cfg, false, false);
    driver.reset();
    expect((await store.admit('k', cfg)).allow).toBe(false);
    expect(driver.transactions).toBe(0);
    expect(driver.roundTrips).toBe(1);
  });

  it('records a failure and grants a probe under the row lock', async () => {
    const clock = new FakeClock();
    const driver = new FakeSqlDriver();
    const store = new SqlResilienceStore(driver, { clock });
    await store.record('k', cfg, false, false);
    expect(driver.transactions).toBe(1);
    for (let i = 0; i < 2; i++) await store.record('k', cfg, false, false);
    clock.advance(1000);
    driver.reset();
    expect(await store.admit('k', cfg)).toEqual({ allow: true, probe: true, status: 'half-open' });
    expect(driver.transactions).toBe(1);
  });
});

function clockAt(ms: number): FakeClock {
  const clock = new FakeClock();
  clock.advance(ms);
  return clock;
}

describe('SqlResilienceStore timestamps', () => {
  it('stamps created_at once and moves updated_at on each state change', async () => {
    const driver = new FakeSqlDriver();
    const clock = clockAt(1_000);
    const store = new SqlResilienceStore(driver, { clock });

    await store.record('k', cfg, false, false);
    const first = await store.snapshot('k');
    expect(first.createdAt).toEqual(new Date(1_000));
    expect(first.updatedAt).toEqual(new Date(1_000));

    clock.advance(500);
    await store.record('k', cfg, false, false);
    clock.advance(500);
    await store.record('k', cfg, true, false);
    const later = await store.snapshot('k');
    expect(later.createdAt).toEqual(new Date(1_000));
    expect(later.updatedAt).toEqual(new Date(2_000));
  });

  it('a success on a clean circuit still writes nothing, so updated_at stays put', async () => {
    const driver = new FakeSqlDriver();
    const clock = clockAt(1_000);
    const store = new SqlResilienceStore(driver, { clock });
    await store.record('k', cfg, false, false);
    await store.record('k', cfg, true, false);
    clock.advance(10_000);
    driver.reset();
    await store.record('k', cfg, true, false);
    expect(driver.rowWrites).toBe(0);
    expect((await store.snapshot('k')).updatedAt).toEqual(new Date(1_000));
  });

  it('a table from before the columns keeps working, without dates', async () => {
    const driver = new FakeSqlDriver(true);
    const store = new SqlResilienceStore(driver, { clock: clockAt(1_000) });
    expect(await store.hasTimestampColumns()).toBe(false);
    await store.record('k', cfg, false, false);
    const snapshot = await store.snapshot('k');
    expect(snapshot).toEqual({ status: 'closed', failures: 1 });
  });

  it('ensureSchema adds the missing columns as nullable BIGINT without a default', async () => {
    const driver = new FakeSqlDriver(true);
    const store = new SqlResilienceStore(driver, { clock: clockAt(1_000) });
    await store.ensureSchema();
    expect(driver.ddl).toContain(
      'ALTER TABLE resilience_circuits ADD COLUMN created_at BIGINT NULL;',
    );
    expect(driver.ddl).toContain(
      'ALTER TABLE resilience_circuits ADD COLUMN updated_at BIGINT NULL;',
    );
    expect(await store.hasTimestampColumns()).toBe(true);
    await store.record('k', cfg, false, false);
    expect((await store.snapshot('k')).createdAt).toEqual(new Date(1_000));
  });
});
