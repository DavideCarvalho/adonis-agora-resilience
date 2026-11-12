import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ResilienceCircuits from '../commands/circuits.js';
import ResilienceReset from '../commands/reset.js';
import { InMemoryResilienceStore, ResilienceService } from '../src/index.js';

describe('resilience commands', () => {
  let appRoot: string;
  let memory: InMemoryResilienceStore;
  let service: ResilienceService;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'resilience-commands-'));
    await writeFile(
      join(appRoot, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
    );
    memory = new InMemoryResilienceStore();
    service = new ResilienceService({ emit: false, stores: { memory }, defaultStore: 'memory' });
    await memory.record('stripe', { threshold: 1, cooldownMs: 60_000 }, false, false);
    await memory.record('mail', { threshold: 5, cooldownMs: 60_000 }, false, false);
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  async function ace() {
    const kernel = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    await kernel.app.init();
    await kernel.app.boot();
    kernel.app.container.bindValue(ResilienceService, service);
    kernel.ui.switchMode('raw');
    return kernel;
  }

  it('resilience:reset closes the circuit and audits it as the CLI', async () => {
    const kernel = await ace();
    const command = await kernel.create(ResilienceReset, ['stripe', '--store=memory']);
    await command.exec();
    command.assertSucceeded();
    expect((await memory.snapshot('stripe')).status).toBe('closed');
    expect(service.recentEvents({ type: 'circuit-reset' })[0]).toMatchObject({
      key: 'stripe',
      by: 'cli',
      via: 'cli',
      previous: 'open',
    });
    command.assertLog('[ green(success) ] Circuit "stripe" on memory is closed (was open).');
  });

  it('resilience:reset refuses an unknown store', async () => {
    const kernel = await ace();
    const command = await kernel.create(ResilienceReset, ['stripe', '--store=nope']);
    await command.exec();
    command.assertFailed();
    expect((await memory.snapshot('stripe')).status).toBe('open');
  });

  it('resilience:circuits refuses an unknown store', async () => {
    const kernel = await ace();
    const command = await kernel.create(ResilienceCircuits, ['--store=nope']);
    await command.exec();
    command.assertFailed();
    command.assertLog('[ red(error) ] Unknown resilience store "nope".', 'stderr');
  });

  it('resilience:circuits lists circuits, filters by status and prints JSON', async () => {
    const kernel = await ace();
    const command = await kernel.create(ResilienceCircuits, ['--status=open', '--json']);
    await command.exec();
    command.assertSucceeded();
    const printed = command.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
    const circuits = JSON.parse(printed) as { key: string }[];
    expect(circuits.map((c) => c.key)).toEqual(['stripe']);

    const table = await kernel.create(ResilienceCircuits, []);
    await table.exec();
    table.assertSucceeded();
    const output = table.ui.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
    expect(output).toContain('stripe');
    expect(output).toContain('mail');
  });
});
