import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Container } from '@adonisjs/core/container';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgoraDoctor from '../commands/agora_doctor.js';
import ResilienceDoctor from '../commands/resilience_doctor.js';
import {
  AGORA_DOCTOR_BINDING,
  type AgoraDoctorCheck,
  type AgoraDoctorRegistry,
  type DoctorApp,
  exitCodeOf,
  registerDoctorChecks,
  renderHuman,
  runDoctor,
  satisfies,
} from '../src/doctor/agora_doctor.js';
import { resilienceDoctorChecks } from '../src/doctor/checks.js';
import {
  bulkhead,
  circuitBreaker,
  InMemoryResilienceStore,
  ResilienceService,
  retry,
  stores,
} from '../src/index.js';

let root: string;

async function fixtureApp(packages: Record<string, Record<string, unknown>>, deps: string[] = []) {
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: Object.fromEntries(deps.map((d) => [d, '*'])) }),
  );
  for (const [name, json] of Object.entries(packages)) {
    await mkdir(join(root, 'node_modules', name), { recursive: true });
    await writeFile(
      join(root, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, ...json }),
    );
  }
}

function fakeApp(config: Record<string, unknown> = {}, inProduction = false) {
  const container = new Container();
  return {
    container,
    inProduction,
    nodeEnvironment: inProduction ? 'production' : 'development',
    makePath: (...paths: string[]) => join(root, ...paths),
    config: {
      get: (key: string, fallback?: unknown) => {
        let value: unknown = config;
        for (const part of key.split('.'))
          value = (value as Record<string, unknown> | undefined)?.[part];
        return value === undefined ? fallback : value;
      },
    },
  };
}

const check = (
  id: string,
  run: AgoraDoctorCheck['run'],
  extra: Partial<AgoraDoctorCheck> = {},
): AgoraDoctorCheck => ({
  id,
  lib: id.split('.')[0] as string,
  title: id,
  run,
  ...extra,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resilience-doctor-'));
  await fixtureApp({});
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('semver matcher', () => {
  it.each([
    ['7.6.0', '^7.3.0', true],
    ['8.0.0', '^7.3.0', false],
    ['10.1.0', '^9.2.0 || ^10.0.0 || ^11.0.0', true],
    ['1.0.0-rc.3', '>=0.5.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0', true],
    ['1.0.0-rc.3', '^1.0.0', false],
    ['2.0.0-rc.1', '>=1.0.0-rc.0 <2.0.0', false],
    ['0.3.2', '^0.3.0', true],
    ['0.4.0', '^0.3.0', false],
    ['5.2.1', '5.x', true],
    ['5.2.1', '~5.1.0', false],
    ['24.1.0', '>=24', true],
  ])('%s in %s → %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe('registry', () => {
  it('creates, reuses, skips duplicates and other versions', async () => {
    const app = fakeApp() as unknown as DoctorApp;
    registerDoctorChecks(app, [check('a.one', () => ({ status: 'ok', message: '' }))]);
    registerDoctorChecks(app, [
      check('a.one', () => ({ status: 'ok', message: '' })),
      check('b.two', () => ({ status: 'ok', message: '' })),
    ]);
    await new Promise((r) => setImmediate(r));
    const registry = (await app.container.make(AGORA_DOCTOR_BINDING)) as AgoraDoctorRegistry;
    expect(registry.checks.map((c) => c.id)).toEqual(['a.one', 'b.two']);

    const other = fakeApp() as unknown as DoctorApp;
    other.container.bindValue(AGORA_DOCTOR_BINDING, { version: 2, checks: [] });
    registerDoctorChecks(other, [check('a.one', () => ({ status: 'ok', message: '' }))]);
    await new Promise((r) => setImmediate(r));
    expect(
      ((await other.container.make(AGORA_DOCTOR_BINDING)) as { checks: unknown[] }).checks,
    ).toEqual([]);
    await expect(runDoctor(other)).rejects.toThrow(/registry version 2/);
  });
});

describe('runner', () => {
  it('orders by lib, runs built-ins, filters, and turns throws and timeouts into errors', async () => {
    const app = fakeApp() as unknown as DoctorApp;
    registerDoctorChecks(app, [
      check('zeta.fine', () => ({ status: 'ok', message: 'fine' })),
      check('alpha.boom', () => {
        throw new Error('kaput');
      }),
      check('alpha.skip', () => ({ status: 'skip', message: 'not used' })),
      check('alpha.deep', () => ({ status: 'warn', message: 'deep' }), { cost: 'deep' }),
    ]);
    const report = await runDoctor(app);
    expect(report.libs.map((l) => l.lib)).toEqual(['alpha', 'zeta']);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([
      ['alpha.registered', 'ok'],
      ['alpha.peers', 'skip'],
      ['alpha.agora-siblings', 'skip'],
      ['alpha.boom', 'error'],
      ['alpha.skip', 'skip'],
      ['zeta.registered', 'ok'],
      ['zeta.peers', 'skip'],
      ['zeta.agora-siblings', 'skip'],
      ['zeta.fine', 'ok'],
    ]);
    expect(report.results.find((r) => r.id === 'alpha.boom')?.message).toBe('kaput');
    expect(exitCodeOf(report)).toBe(1);

    const deep = await runDoctor(app, { deep: true, libs: ['alpha'] });
    expect(deep.results.find((r) => r.id === 'alpha.deep')?.status).toBe('warn');
    expect(deep.libs.map((l) => l.lib)).toEqual(['alpha']);

    const only = await runDoctor(app, { only: 'zeta.fine' });
    expect(only.results.map((r) => r.id)).toEqual(['zeta.fine']);
    await expect(runDoctor(app, { only: 'nope.nope' })).rejects.toThrow(/no check has the id/);
  });

  it('times a slow check out after 5s', async () => {
    vi.useFakeTimers();
    const app = fakeApp() as unknown as DoctorApp;
    registerDoctorChecks(app, [check('slow.hang', () => new Promise(() => {}))]);
    const pending = runDoctor(app, { only: 'slow.hang' });
    await vi.advanceTimersByTimeAsync(5_000);
    const report = await pending;
    expect(report.results[0]).toMatchObject({ status: 'error', message: 'timed out after 5s' });
  });

  it('renders the human report, hiding skips unless verbose, and degrades symbols', async () => {
    const app = fakeApp() as unknown as DoctorApp;
    registerDoctorChecks(app, [
      check('demo.warn', () => ({ status: 'warn', message: 'careful', fix: 'do this' })),
    ]);
    const report = await runDoctor(app);
    const text = renderHuman(report, { symbols: false });
    expect(text).toContain('@adonis-agora doctor · development · 1 libs · 4 checks');
    expect(text).toContain('  warn demo.warn\n    careful\n    fix: do this');
    expect(text).not.toContain('Peer dependencies');
    expect(text).toContain('(skipped 2, run with --verbose)');
    expect(renderHuman(report, { verbose: true })).toContain('- Peer dependencies');
    expect(exitCodeOf(report)).toBe(0);
    expect(exitCodeOf(report, true)).toBe(1);
  });

  it('checks peers against the installed versions, and the release train', async () => {
    await fixtureApp(
      {
        '@adonis-agora/resilience': {
          version: '1.0.0-rc.1',
          peerDependencies: {
            '@adonisjs/core': '^7.3.0',
            ioredis: '^5.0.0 || ^6.0.0',
            '@adonisjs/lucid': '^22.0.0',
          },
          peerDependenciesMeta: {
            ioredis: { optional: true },
            '@adonisjs/lucid': { optional: true },
          },
        },
        '@adonis-agora/durable': { version: '0.40.0' },
        '@adonisjs/core': { version: '6.9.0' },
        ioredis: { version: '6.0.0' },
      },
      ['@adonis-agora/resilience', '@adonis-agora/durable'],
    );
    const app = fakeApp() as unknown as DoctorApp;
    registerDoctorChecks(app, resilienceDoctorChecks());
    const report = await runDoctor(app, { libs: ['resilience'] });
    const peers = report.results.filter((r) => r.id === 'resilience.peers');
    expect(peers).toEqual([
      expect.objectContaining({
        status: 'error',
        message: 'peer @adonisjs/core@6.9.0 is outside ^7.3.0',
      }),
    ]);
    expect(report.results.find((r) => r.id === 'resilience.agora-siblings')).toMatchObject({
      status: 'warn',
      message: '1.0.0-rc.1 is installed with durable@0.40.0',
    });
    expect(report.libs).toEqual([
      { lib: 'resilience', package: '@adonis-agora/resilience', version: '1.0.0-rc.1' },
    ]);
  });

  it('--no-boot runs the built-in checks of every installed lib, without the registry', async () => {
    await fixtureApp(
      {
        '@adonis-agora/resilience': { version: '1.0.0-rc.1' },
        '@adonis-agora/durable': { version: '1.0.0-rc.1' },
      },
      ['@adonis-agora/resilience', '@adonis-agora/durable'],
    );
    const app = fakeApp() as unknown as DoctorApp;
    registerDoctorChecks(app, resilienceDoctorChecks());
    const report = await runDoctor(app, { noBoot: true });
    expect(report.results.map((r) => r.id)).toEqual([
      'durable.peers',
      'durable.agora-siblings',
      'resilience.peers',
      'resilience.agora-siblings',
    ]);
  });
});

describe('resilience checks', () => {
  async function run(config: Record<string, unknown>, production = false, deep = false) {
    const app = fakeApp({ resilience: config }, production);
    registerDoctorChecks(app as unknown as DoctorApp, resilienceDoctorChecks());
    const report = await runDoctor(app as unknown as DoctorApp, { libs: ['resilience'], deep });
    return Object.fromEntries(
      report.results
        .filter(
          (r) =>
            !r.id.includes('.peers') && !r.id.includes('siblings') && !r.id.endsWith('.registered'),
        )
        .map((r) => [r.id, r]),
    );
  }

  it('resilience.store: memory is fine in dev, a warning in production, a missing default an error', async () => {
    expect((await run({}))['resilience.store']).toMatchObject({ status: 'ok' });
    expect((await run({}, true))['resilience.store']).toMatchObject({ status: 'warn' });
    expect(
      (await run({ default: 'redis', stores: { redis: stores.redis() } }, true))[
        'resilience.store'
      ],
    ).toMatchObject({ status: 'ok', message: 'default store: redis (redis)' });
    expect((await run({ default: 'nope', stores: {} }))['resilience.store']).toMatchObject({
      status: 'error',
    });
  });

  it('resilience.policies reports each factory that throws, including an unknown store name', async () => {
    const results = await run({
      stores: { memory: stores.memory() },
      policies: {
        fine: () => retry({ attempts: 2 }),
        typo: () => circuitBreaker({ key: 'x', store: 'redis', threshold: 1, cooldownMs: 1 }),
      },
    });
    expect(results['resilience.policies']).toMatchObject({
      status: 'error',
      message: 'policy "typo" throws when built: store "redis" is not in config.stores',
    });
  });

  it('resilience.limits-scope warns about per-process limits in production', async () => {
    const config = { policies: { pool: () => bulkhead({ key: 'pool', limit: 2 }) } };
    expect((await run(config))['resilience.limits-scope']).toMatchObject({ status: 'ok' });
    expect((await run(config, true))['resilience.limits-scope']).toMatchObject({ status: 'warn' });
    expect((await run({}))['resilience.limits-scope']).toMatchObject({ status: 'skip' });
  });

  it('resilience.store-reachable (deep) asks every store', async () => {
    const app = fakeApp({ resilience: {} });
    const broken = new InMemoryResilienceStore();
    broken.snapshot = () => Promise.reject(new Error('ECONNREFUSED'));
    app.container.bindValue(
      ResilienceService,
      new ResilienceService({
        emit: false,
        stores: { memory: new InMemoryResilienceStore(), broken },
      }),
    );
    registerDoctorChecks(app as unknown as DoctorApp, resilienceDoctorChecks());
    const report = await runDoctor(app as unknown as DoctorApp, {
      only: 'resilience.store-reachable',
    });
    expect(report.results.map((r) => [r.status, r.message])).toEqual([
      ['ok', 'memory answers'],
      ['error', 'broken does not answer: ECONNREFUSED'],
    ]);
  });
});

describe('agora:doctor command', () => {
  async function ace(config: Record<string, unknown>) {
    await writeFile(join(root, 'adonisrc.ts'), `export default {}\n`);
    const kernel = await new AceFactory().make(pathToFileURL(`${root}/`), {
      importer: (filePath) => import(filePath),
    });
    await kernel.app.init();
    await kernel.app.boot();
    kernel.app.config.set('resilience', config);
    registerDoctorChecks(kernel.app as unknown as DoctorApp, resilienceDoctorChecks());
    kernel.ui.switchMode('raw');
    return kernel;
  }

  it('prints one JSON object and exits 1 on an error', async () => {
    const kernel = await ace({ default: 'nope', stores: {} });
    const command = await kernel.create(AgoraDoctor, ['--json']);
    await command.exec();
    expect(command.exitCode).toBe(1);
    const report = JSON.parse(
      command.logger
        .getLogs()
        .map((l) => l.message)
        .join(''),
    );
    expect(report).toMatchObject({ version: 1, summary: { error: 1 } });
    expect(report.results.find((r: { id: string }) => r.id === 'resilience.store').status).toBe(
      'error',
    );
  });

  it('exits 2 for an unknown --only id, and resilience:doctor runs resilience only', async () => {
    const kernel = await ace({});
    const unknown = await kernel.create(AgoraDoctor, ['--only=nope.nope']);
    await unknown.exec();
    expect(unknown.exitCode).toBe(2);

    const alias = await kernel.create(ResilienceDoctor, ['--json', '--strict']);
    await alias.exec();
    const report = JSON.parse(alias.logger.getLogs().at(-1)?.message ?? '');
    expect(new Set(report.results.map((r: { lib: string }) => r.lib))).toEqual(
      new Set(['resilience']),
    );
    expect(alias.exitCode).toBe(0);
  });
});
