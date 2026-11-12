import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Container } from '@adonisjs/core/container';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResilienceProvider from '../providers/resilience_provider.js';
import {
  AGORA_DOCTOR_BINDING,
  type AgoraDoctorRegistry,
  readDoctorChecks,
  registerDoctorChecks,
  runAgoraDoctor,
} from '../src/doctor/agora_doctor.js';
import { resilienceDoctorChecks } from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';
import {
  bulkhead,
  circuitBreaker,
  InMemoryResilienceStore,
  ResilienceService,
  retry,
  stores,
} from '../src/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resilience-doctor-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeApp(config: Record<string, unknown> = {}, inProduction = false) {
  return {
    container: new Container(),
    inProduction,
    inTest: false,
    nodeEnvironment: inProduction ? 'production' : 'development',
    makePath: (...paths: string[]) => join(root, ...paths),
    config: {
      get: (key: string, fallback?: unknown) => {
        let value: unknown = config;
        for (const part of key.split('.')) {
          value = (value as Record<string, unknown> | undefined)?.[part];
        }
        return value === undefined ? fallback : value;
      },
    },
  };
}

async function results(config: Record<string, unknown>, production = false) {
  const app = fakeApp({ resilience: config }, production) as unknown as ApplicationService;
  const { report } = await runAgoraDoctor(app, resilienceDoctorChecks());
  return Object.fromEntries(
    report.results
      .filter((r) => !/\.(peers|agora-siblings|registered)$/.test(r.id))
      .map((r) => [r.id, r]),
  );
}

describe('registration', () => {
  it('the provider adds the resilience checks to the agora.doctor registry', async () => {
    const app = fakeApp();
    new ResilienceProvider(app as never).register();
    await new Promise((r) => setImmediate(r));
    const registry = (await app.container.make(
      AGORA_DOCTOR_BINDING as never,
    )) as AgoraDoctorRegistry;
    expect(registry.checks.map((c) => c.id)).toEqual([
      'resilience.store',
      'resilience.policies',
      'resilience.limits-scope',
      'resilience.store-reachable',
    ]);
  });

  it('joins a registry another lib created first', async () => {
    const app = fakeApp();
    await registerDoctorChecks(app.container as never, [
      {
        id: 'durable.config',
        lib: 'durable',
        title: 'x',
        run: () => ({ status: 'ok', message: '' }),
      },
    ]);
    new ResilienceProvider(app as never).register();
    await new Promise((r) => setImmediate(r));
    const ids = (await readDoctorChecks(app.container as never)).map((c) => c.id);
    expect(ids[0]).toBe('durable.config');
    expect(ids).toContain('resilience.store');
  });

  it('publishes the checks on the ./doctor entry for agora:doctor --no-boot', () => {
    expect(agoraDoctorChecks.map((c) => c.id)).toEqual(resilienceDoctorChecks().map((c) => c.id));
    expect(agoraDoctorChecks.every((c) => c.lib === 'resilience')).toBe(true);
  });
});

describe('resilience checks', () => {
  it('resilience.store: memory is fine in dev, a warning in production, a missing default an error', async () => {
    expect((await results({}))['resilience.store']).toMatchObject({ status: 'ok' });
    expect((await results({}, true))['resilience.store']).toMatchObject({ status: 'warn' });
    expect(
      (await results({ default: 'redis', stores: { redis: stores.redis() } }, true))[
        'resilience.store'
      ],
    ).toMatchObject({ status: 'ok', message: 'default store: redis (redis)' });
    expect((await results({ default: 'nope', stores: {} }))['resilience.store']).toMatchObject({
      status: 'error',
    });
  });

  it('resilience.policies reports each factory that throws, including an unknown store name', async () => {
    const out = await results({
      stores: { memory: stores.memory() },
      policies: {
        fine: () => retry({ attempts: 2 }),
        typo: () => circuitBreaker({ key: 'x', store: 'redis', threshold: 1, cooldownMs: 1 }),
      },
    });
    expect(out['resilience.policies']).toMatchObject({
      status: 'error',
      message: 'policy "typo" throws when built: store "redis" is not in config.stores',
    });
    const fine = await results({ policies: { fine: () => retry({ attempts: 1 }) } });
    expect(fine['resilience.policies']).toMatchObject({ status: 'ok' });
  });

  it('resilience.limits-scope warns about per-process limits in production', async () => {
    const config = { policies: { pool: () => bulkhead({ key: 'pool', limit: 2 }) } };
    expect((await results(config))['resilience.limits-scope']).toMatchObject({ status: 'ok' });
    expect((await results(config, true))['resilience.limits-scope']).toMatchObject({
      status: 'warn',
    });
    expect((await results({}))['resilience.limits-scope']).toMatchObject({ status: 'skip' });
  });

  it('resilience.store-reachable runs only with --deep and asks every store', async () => {
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
    const shallow = await runAgoraDoctor(
      app as unknown as ApplicationService,
      resilienceDoctorChecks(),
    );
    expect(shallow.report.results.some((r) => r.id === 'resilience.store-reachable')).toBe(false);
    const { report, exitCode } = await runAgoraDoctor(
      app as unknown as ApplicationService,
      resilienceDoctorChecks(),
      { deep: true, libs: ['resilience'] },
    );
    expect(
      report.results
        .filter((r) => r.id === 'resilience.store-reachable')
        .map((r) => [r.status, r.message]),
    ).toEqual([
      ['ok', 'memory answers'],
      ['error', 'broken does not answer: ECONNREFUSED'],
    ]);
    expect(exitCode).toBe(1);
  });
});

describe('resilience:doctor command (built)', () => {
  const built = fileURLToPath(new URL('../dist/commands/resilience_doctor.js', import.meta.url));

  if (!existsSync(built)) {
    if (process.env.CI) {
      it('runs the built command', () => {
        expect.fail(`${built} does not exist: run \`pnpm build\` before \`pnpm test\`.`);
      });
    } else {
      it.skip('dist/ missing — run `pnpm --filter @adonis-agora/resilience build` first', () => {});
    }
    return;
  }

  it('prints the resilience report as JSON and exits 1 on an error', async () => {
    await writeFile(join(root, 'adonisrc.ts'), 'export default {}\n');
    const kernel = await new AceFactory().make(pathToFileURL(`${root}/`), {
      importer: (filePath) => import(filePath),
    });
    await kernel.app.init();
    await kernel.app.boot();
    kernel.app.config.set('resilience', { default: 'nope', stores: {} });
    await registerDoctorChecks(kernel.app.container as never, resilienceDoctorChecks());
    await registerDoctorChecks(kernel.app.container as never, [
      { id: 'other.fine', lib: 'other', title: 'x', run: () => ({ status: 'ok', message: '' }) },
    ]);
    kernel.ui.switchMode('raw');

    const { default: ResilienceDoctor } = await import(built);
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    let exitCode: number | undefined;
    try {
      const command = await kernel.create(ResilienceDoctor, ['--json']);
      await command.exec();
      exitCode = command.exitCode;
    } finally {
      spy.mockRestore();
    }
    expect(exitCode).toBe(1);
    const report = JSON.parse(written.join(''));
    expect(new Set(report.results.map((r: { lib: string }) => r.lib))).toEqual(
      new Set(['resilience']),
    );
    expect(report.results.find((r: { id: string }) => r.id === 'resilience.store').status).toBe(
      'error',
    );
  });
});
