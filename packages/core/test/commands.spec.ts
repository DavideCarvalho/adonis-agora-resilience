import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ResilienceCircuitsList,
  ResilienceCircuitsReset,
  ResilienceCircuitsShow,
} from '../commands/circuits.js';
import {
  ResilienceBulkheadsList,
  ResilienceBulkheadsShow,
  ResilienceRateLimitersList,
  ResilienceRateLimitersShow,
} from '../commands/limits.js';
import loader from '../commands/main.js';
import { ResiliencePoliciesList } from '../commands/policies.js';
import {
  bulkhead,
  InMemoryResilienceStore,
  ResilienceService,
  rateLimiter,
  retry,
  wrap,
} from '../src/index.js';

const PROMPT =
  'Reset circuit "stripe" (memory, open)? It closes now and calls go through to the dependency again.';

type Kernel = Awaited<ReturnType<typeof AceFactory.prototype.make>>;

describe('resilience commands', () => {
  let appRoot: string;
  let memory: InMemoryResilienceStore;
  let service: ResilienceService;
  let release: () => void;
  let running: Promise<unknown>;
  const tty = process.stdin.isTTY;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'resilience-commands-'));
    await writeFile(
      join(appRoot, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
    );
    memory = new InMemoryResilienceStore();
    service = new ResilienceService({
      emit: false,
      stores: { memory },
      defaultStore: 'memory',
      policies: {
        sms: () =>
          wrap(
            rateLimiter({ key: 'sms', limit: 10, intervalMs: 60_000 }),
            bulkhead({ key: 'sms-pool', limit: 3 }),
          ),
        mail: () => retry({ attempts: 2 }),
      },
    });
    await memory.record('stripe', { threshold: 1, cooldownMs: 60_000 }, false, false);
    await memory.record('mail', { threshold: 5, cooldownMs: 60_000 }, false, false);
    // One call holds a bulkhead slot and a rate-limit token while the tests run.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    running = service.execute('sms', () => gate);
    await new Promise((resolve) => setImmediate(resolve));
  });

  afterEach(async () => {
    release();
    await running;
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    await rm(appRoot, { recursive: true, force: true });
  });

  async function ace(): Promise<Kernel> {
    const kernel = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    await kernel.app.init();
    await kernel.app.boot();
    kernel.app.container.bindValue(ResilienceService, service);
    kernel.ui.switchMode('raw');
    return kernel;
  }

  async function exec(command: unknown, argv: string[]) {
    const kernel = await ace();
    const instance = await kernel.create(command as never, argv);
    await instance.exec();
    return instance;
  }

  function printed(instance: { logger: { getLogs(): { message: string }[] } }): string {
    return instance.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  }

  function output(instance: { ui: { logger: { getLogs(): { message: string }[] } } }): string {
    return instance.ui.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  }

  it('registers every command under resilience:<noun>:<verb>', async () => {
    const names = (await loader.getMetaData()).map((c) => c.commandName).sort();
    expect(names).toEqual([
      'agora:doctor',
      'resilience:bulkheads:list',
      'resilience:bulkheads:show',
      'resilience:circuits:list',
      'resilience:circuits:reset',
      'resilience:circuits:show',
      'resilience:doctor',
      'resilience:policies:list',
      'resilience:rate-limiters:list',
      'resilience:rate-limiters:show',
    ]);
  });

  describe('resilience:circuits:list', () => {
    it('lists circuits open first, as a table', async () => {
      const command = await exec(ResilienceCircuitsList, []);
      command.assertSucceeded();
      const out = output(command);
      expect(out.indexOf('stripe')).toBeGreaterThan(-1);
      expect(out.indexOf('stripe')).toBeLessThan(out.indexOf('mail'));
    });

    it('filters by status and prints the { data, meta } page as JSON', async () => {
      const command = await exec(ResilienceCircuitsList, ['--status=open', '--json']);
      command.assertSucceeded();
      const page = JSON.parse(printed(command)) as {
        data: { key: string; status: string }[];
        meta: { hasNext: boolean };
      };
      expect(page.data.map((c) => c.key)).toEqual(['stripe']);
      expect(page.data[0]).toMatchObject({ status: 'open', store: 'memory', scope: 'process' });
      expect(page.meta.hasNext).toBe(false);
    });

    it('says when more circuits match than --first', async () => {
      const command = await exec(ResilienceCircuitsList, ['--first=1', '--json']);
      command.assertSucceeded();
      const page = JSON.parse(printed(command)) as { data: unknown[]; meta: { hasNext: boolean } };
      expect(page.data).toHaveLength(1);
      expect(page.meta.hasNext).toBe(true);
    });

    it('refuses an unknown store, a bad status and a bad --first', async () => {
      const store = await exec(ResilienceCircuitsList, ['--store=nope']);
      store.assertFailed();
      store.assertLog('[ red(error) ] Unknown resilience store "nope".', 'stderr');
      (await exec(ResilienceCircuitsList, ['--status=broken'])).assertFailed();
      (await exec(ResilienceCircuitsList, ['--first=0'])).assertFailed();
    });
  });

  describe('resilience:circuits:show', () => {
    it('shows one circuit as a table and as JSON', async () => {
      const table = await exec(ResilienceCircuitsShow, ['stripe']);
      table.assertSucceeded();
      expect(output(table)).toContain('open');
      const json = await exec(ResilienceCircuitsShow, ['stripe', '--store=memory', '--json']);
      json.assertSucceeded();
      expect(JSON.parse(printed(json))).toMatchObject({
        key: 'stripe',
        status: 'open',
        failures: 1,
        store: 'memory',
      });
    });

    it('refuses an unknown store', async () => {
      (await exec(ResilienceCircuitsShow, ['stripe', '--store=nope'])).assertFailed();
    });
  });

  describe('resilience:circuits:reset', () => {
    it('with --force closes the circuit and audits it as cli:<os user>', async () => {
      const command = await exec(ResilienceCircuitsReset, ['stripe', '--store=memory', '--force']);
      command.assertSucceeded();
      expect((await memory.snapshot('stripe')).status).toBe('closed');
      expect(service.recentEvents({ type: 'circuit-reset' }).data[0]).toMatchObject({
        key: 'stripe',
        by: `cli:${userInfo().username}`,
        via: 'cli',
        previous: 'open',
      });
      command.assertLog('[ green(success) ] Circuit "stripe" on memory is closed (was open).');
    });

    it('prints the circuit after the reset with --json', async () => {
      const command = await exec(ResilienceCircuitsReset, ['stripe', '--force', '--json']);
      command.assertSucceeded();
      expect(JSON.parse(printed(command))).toMatchObject({ key: 'stripe', status: 'closed' });
    });

    it('refuses without --force when nobody can confirm', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const command = await exec(ResilienceCircuitsReset, ['stripe']);
      command.assertFailed();
      expect((await memory.snapshot('stripe')).status).toBe('open');
    });

    it('asks in a terminal: no leaves the circuit open, yes resets it', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const kernel = await ace();
      const declined = await kernel.create(ResilienceCircuitsReset, ['stripe']);
      declined.prompt.trap(PROMPT).reject();
      await declined.exec();
      declined.assertFailed();
      expect((await memory.snapshot('stripe')).status).toBe('open');

      const accepted = await kernel.create(ResilienceCircuitsReset, ['stripe']);
      accepted.prompt.trap(PROMPT).accept();
      await accepted.exec();
      accepted.assertSucceeded();
      expect((await memory.snapshot('stripe')).status).toBe('closed');
    });

    it('refuses an unknown store', async () => {
      (await exec(ResilienceCircuitsReset, ['stripe', '--store=nope', '--force'])).assertFailed();
      expect((await memory.snapshot('stripe')).status).toBe('open');
    });
  });

  describe('resilience:bulkheads', () => {
    it('lists bulkheads with the calls running now', async () => {
      const table = await exec(ResilienceBulkheadsList, []);
      table.assertSucceeded();
      expect(output(table)).toContain('sms-pool');
      const json = await exec(ResilienceBulkheadsList, ['--prefix=sms', '--json']);
      const page = JSON.parse(printed(json)) as { data: unknown[]; meta: unknown };
      expect(page.data).toEqual([
        expect.objectContaining({ key: 'sms-pool', active: 1, limit: 3, policy: 'sms' }),
      ]);
      expect(page.meta).toMatchObject({ hasNext: false });
    });

    it('shows one bulkhead', async () => {
      const json = await exec(ResilienceBulkheadsShow, ['sms-pool', '--json']);
      json.assertSucceeded();
      expect(JSON.parse(printed(json))).toMatchObject({ key: 'sms-pool', active: 1 });
      (await exec(ResilienceBulkheadsShow, ['sms-pool'])).assertSucceeded();
    });

    it('refuses an unknown store', async () => {
      (await exec(ResilienceBulkheadsList, ['--store=nope'])).assertFailed();
      (await exec(ResilienceBulkheadsShow, ['sms-pool', '--store=nope'])).assertFailed();
    });
  });

  describe('resilience:rate-limiters', () => {
    it('lists rate limiters with the budget left', async () => {
      const table = await exec(ResilienceRateLimitersList, []);
      table.assertSucceeded();
      expect(output(table)).toContain('10/60000ms');
      const json = await exec(ResilienceRateLimitersList, ['--json']);
      const page = JSON.parse(printed(json)) as { data: unknown[] };
      expect(page.data).toEqual([
        expect.objectContaining({ key: 'sms', remaining: 9, limit: 10, intervalMs: 60_000 }),
      ]);
    });

    it('shows one rate limiter', async () => {
      const json = await exec(ResilienceRateLimitersShow, ['sms', '--json']);
      json.assertSucceeded();
      expect(JSON.parse(printed(json))).toMatchObject({ key: 'sms', remaining: 9 });
      (await exec(ResilienceRateLimitersShow, ['sms'])).assertSucceeded();
    });

    it('refuses an unknown store', async () => {
      (await exec(ResilienceRateLimitersList, ['--store=nope'])).assertFailed();
      (await exec(ResilienceRateLimitersShow, ['sms', '--store=nope'])).assertFailed();
    });
  });

  describe('resilience:policies:list', () => {
    it('lists the named policies as a table and as JSON', async () => {
      const table = await exec(ResiliencePoliciesList, []);
      table.assertSucceeded();
      expect(output(table)).toContain('sms');
      const json = await exec(ResiliencePoliciesList, ['--json']);
      json.assertSucceeded();
      const { data } = JSON.parse(printed(json)) as { data: { name: string; kinds: string[] }[] };
      expect(data.map((p) => p.name)).toEqual(['sms', 'mail']);
      expect(data[1]!.kinds[0]).toMatch(/^retry/);
    });

    it('fails when a policy cannot be built', async () => {
      service = new ResilienceService({
        emit: false,
        policies: {
          broken: () => {
            throw new Error('missing key');
          },
        },
      });
      const command = await exec(ResiliencePoliciesList, []);
      command.assertFailed();
      expect(output(command)).toContain('missing key');
    });
  });
});
