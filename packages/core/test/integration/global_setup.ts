import { execFileSync } from 'node:child_process';

/**
 * One Postgres for the whole integration run, through the docker CLI, handed to the spec files in
 * `RESILIENCE_TEST_PG_URL`. Set that variable yourself to use a server you already run.
 */
let container: string | undefined;

export async function setup(): Promise<void> {
  if (process.env.RESILIENCE_TEST_PG_URL) return;
  container = execFileSync('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_PASSWORD=resilience',
    'postgres:17-alpine',
  ])
    .toString()
    .trim();
  const port = execFileSync('docker', ['port', container, '5432/tcp'])
    .toString()
    .trim()
    .split('\n')[0]
    ?.split(':')
    .pop();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      execFileSync(
        'docker',
        ['exec', container, 'psql', '-U', 'postgres', '-h', '127.0.0.1', '-c', 'SELECT 1'],
        { stdio: 'ignore' },
      );
      process.env.RESILIENCE_TEST_PG_URL = `postgres://postgres:resilience@127.0.0.1:${port}/postgres`;
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Postgres did not start');
}

export async function teardown(): Promise<void> {
  if (container) execFileSync('docker', ['stop', container], { stdio: 'ignore' });
}
