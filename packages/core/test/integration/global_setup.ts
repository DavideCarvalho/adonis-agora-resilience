import { execFileSync } from 'node:child_process';

/**
 * One Postgres and one MySQL for the whole integration run, through the docker CLI, handed to the
 * spec files in `RESILIENCE_TEST_PG_URL` / `RESILIENCE_TEST_MYSQL_URL`. Set those yourself to use
 * servers you already run (the MySQL URL names the default database, e.g. `/resilience`).
 */
const containers: string[] = [];

function start(args: string[], port: string): { id: string; port: string } {
  const id = execFileSync('docker', ['run', '-d', '--rm', '-p', `127.0.0.1::${port}`, ...args])
    .toString()
    .trim();
  containers.push(id);
  const mapped = execFileSync('docker', ['port', id, `${port}/tcp`])
    .toString()
    .trim()
    .split('\n')[0]
    ?.split(':')
    .pop();
  return { id, port: mapped as string };
}

async function waitFor(check: () => void, what: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`${what} did not start`);
}

async function startPostgres(): Promise<string> {
  const pg = start(['-e', 'POSTGRES_PASSWORD=resilience', 'postgres:17-alpine'], '5432');
  await waitFor(
    () =>
      execFileSync(
        'docker',
        ['exec', pg.id, 'psql', '-U', 'postgres', '-h', '127.0.0.1', '-c', 'SELECT 1'],
        { stdio: 'ignore' },
      ),
    'Postgres',
    90_000,
  );
  return `postgres://postgres:resilience@127.0.0.1:${pg.port}/postgres`;
}

async function startMysql(): Promise<string> {
  const mysql = start(
    ['-e', 'MYSQL_ROOT_PASSWORD=resilience', '-e', 'MYSQL_DATABASE=resilience', 'mysql:8.4'],
    '3306',
  );
  await waitFor(
    () =>
      execFileSync(
        'docker',
        [
          'exec',
          mysql.id,
          'mysql',
          '-uroot',
          '-presilience',
          '-h127.0.0.1',
          '-Dresilience',
          '-e',
          'SELECT 1',
        ],
        { stdio: 'ignore' },
      ),
    'MySQL',
    180_000,
  );
  return `mysql://root:resilience@127.0.0.1:${mysql.port}/resilience`;
}

export async function setup(): Promise<void> {
  const [pg, mysql] = await Promise.all([
    process.env.RESILIENCE_TEST_PG_URL ?? startPostgres(),
    process.env.RESILIENCE_TEST_MYSQL_URL ?? startMysql(),
  ]);
  process.env.RESILIENCE_TEST_PG_URL = pg;
  process.env.RESILIENCE_TEST_MYSQL_URL = mysql;
}

export async function teardown(): Promise<void> {
  for (const id of containers) execFileSync('docker', ['stop', id], { stdio: 'ignore' });
}
