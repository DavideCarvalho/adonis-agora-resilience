import { lucidDatabase, runIntegrationSuite } from './suite.js';

function url(): URL {
  const value = process.env.RESILIENCE_TEST_PG_URL;
  if (!value) throw new Error('RESILIENCE_TEST_PG_URL is unset — run test:integration');
  return new URL(value);
}

runIntegrationSuite({
  name: 'Postgres',
  // No searchPath: the connection's default schema stays `public`.
  makeDatabase(credentials) {
    const u = url();
    if (credentials) {
      u.username = credentials.user;
      u.password = credentials.password;
    }
    return lucidDatabase({ client: 'pg', connection: u.toString() });
  },
  defaultSchema: 'public',
  quote: (identifier) => `"${identifier}"`,
  dropSchema: (name) => `DROP SCHEMA IF EXISTS "${name}" CASCADE`,
  createSchema: 'CREATE SCHEMA IF NOT EXISTS',
  rows: (result) => (result as { rows: Record<string, unknown>[] }).rows,
  async createLimitedUser(db) {
    // A new role has no CREATE on the database (PUBLIC gets only CONNECT and TEMP).
    const user = `res_ro_${Date.now()}`;
    await db.rawQuery(`CREATE ROLE ${user} LOGIN PASSWORD 'pw'`);
    return {
      user,
      password: 'pw',
      drop: async () => void (await db.rawQuery(`DROP ROLE ${user}`)),
    };
  },
  grant: /GRANT CREATE ON DATABASE/,
  missingTable: /does not exist/,
});
