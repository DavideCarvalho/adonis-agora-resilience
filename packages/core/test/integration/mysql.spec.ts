import { lucidDatabase, runIntegrationSuite } from './suite.js';

function url(): URL {
  const value = process.env.RESILIENCE_TEST_MYSQL_URL;
  if (!value) throw new Error('RESILIENCE_TEST_MYSQL_URL is unset — run test:integration');
  return new URL(value);
}

runIntegrationSuite({
  name: 'MySQL',
  makeDatabase(credentials) {
    const u = url();
    return lucidDatabase({
      client: 'mysql2',
      connection: {
        host: u.hostname,
        port: Number(u.port),
        user: credentials?.user ?? decodeURIComponent(u.username),
        password: credentials?.password ?? decodeURIComponent(u.password),
        database: u.pathname.slice(1),
      },
    });
  },
  defaultSchema: 'resilience',
  quote: (identifier) => `\`${identifier}\``,
  dropSchema: (name) => `DROP DATABASE IF EXISTS \`${name}\``,
  createSchema: 'CREATE DATABASE IF NOT EXISTS',
  rows: (result) => (result as [Record<string, unknown>[]])[0],
  async createLimitedUser(db) {
    // Can use the default database, cannot create others.
    const user = `res_ro_${Date.now()}`;
    await db.rawQuery(`CREATE USER '${user}'@'%' IDENTIFIED BY 'pw'`);
    await db.rawQuery(`GRANT ALL ON \`resilience\`.* TO '${user}'@'%'`);
    return {
      user,
      password: 'pw',
      drop: async () => void (await db.rawQuery(`DROP USER '${user}'@'%'`)),
    };
  },
  grant: /GRANT CREATE ON \*\.\*/,
  missingTable: /doesn't exist|Unknown database/,
});
