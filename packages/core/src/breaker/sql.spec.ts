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
  run?: (sql: string, params: unknown[]) => Promise<void>;

  constructor(withRun = true) {
    if (withRun) {
      this.run = async (sql, params) => {
        await this.execute(sql, params);
      };
    }
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

  async exec(): Promise<void> {}

  private async execute(sql: string, params: unknown[]): Promise<unknown[]> {
    await new Promise((r) => setImmediate(r));
    this.roundTrips += 1;
    const text = sql.trim();
    if (text.startsWith('INSERT')) {
      const key = params[0] as string;
      if (!this.rows.has(key)) {
        this.rows.set(key, { status: 'closed', failures: 0, open_until: 0, probes: 0 });
        this.rowWrites += 1;
      }
      return [];
    }
    if (text.startsWith('DELETE')) {
      if (this.rows.delete(params[0] as string)) this.rowWrites += 1;
      return [];
    }
    if (text.startsWith('SELECT')) {
      const row = this.rows.get(params[0] as string);
      return row ? [{ ...row }] : [];
    }
    if (text.includes("status = 'closed'")) {
      const row = this.rows.get(params[0] as string);
      if (row && (row.status !== 'closed' || row.failures !== 0 || row.open_until !== 0)) {
        Object.assign(row, { status: 'closed', failures: 0, open_until: 0 });
        this.rowWrites += 1;
      }
      return [];
    }
    const [status, failures, open_until, probes, key] = params as [
      string,
      number,
      number,
      number,
      string,
    ];
    const row = this.rows.get(key);
    if (row) {
      Object.assign(row, { status, failures, open_until, probes });
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

runResilienceStoreContract(
  'SqlResilienceStore (driver without run)',
  (clock) => new SqlResilienceStore(new FakeSqlDriver(false), { clock }),
);

describe('SqlResilienceStore round trips', () => {
  it('a successful call on a closed circuit takes no transaction and writes nothing', async () => {
    const driver = new FakeSqlDriver();
    const store = new SqlResilienceStore(driver, { clock: new FakeClock() });
    for (let i = 0; i < 5; i++) {
      const a = await store.admit('k', cfg);
      expect(a).toEqual({ allow: true, probe: false, status: 'closed' });
      expect(await store.record('k', cfg, true, a.probe)).toBe('closed');
    }
    expect(driver.transactions).toBe(0);
    expect(driver.roundTrips).toBe(10);
    expect(driver.rowWrites).toBe(0);
  });

  it('falls back to a one-statement transaction when the driver has no run()', async () => {
    const driver = new FakeSqlDriver(false);
    const store = new SqlResilienceStore(driver, { clock: new FakeClock() });
    await store.admit('k', cfg);
    await store.record('k', cfg, true, false);
    expect(driver.transactions).toBe(1);
    expect(driver.roundTrips).toBe(2);
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
