import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { CircuitStatus } from '../src/breaker/types.js';
import { ResilienceService } from '../src/resilience_service.js';

/**
 * `node ace resilience:circuits [--status=open] [--store=redis] [--json]` — list circuit breakers
 * with their live state, open first.
 */
export default class ResilienceCircuits extends BaseCommand {
  static override commandName = 'resilience:circuits';
  static override description = 'List circuit breakers and their state';
  static override options: CommandOptions = { startApp: true };

  declare status?: string;
  declare store?: string;
  declare json?: boolean;

  static {
    ResilienceCircuits.defineFlag('status', {
      type: 'string',
      description: 'Only circuits in this state (closed, open, half-open)',
    });
    ResilienceCircuits.defineFlag('store', {
      type: 'string',
      description: 'Only this store (a name from config/resilience.ts)',
    });
    ResilienceCircuits.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    if (this.status !== undefined && !['closed', 'open', 'half-open'].includes(this.status)) {
      this.logger.error(`--status must be closed, open or half-open`);
      this.exitCode = 1;
      return;
    }
    const resilience = await this.app.container.make(ResilienceService);
    if (this.store !== undefined && !resilience.storeNames().includes(this.store)) {
      this.logger.error(`Unknown resilience store "${this.store}".`);
      this.exitCode = 1;
      return;
    }
    const { data: circuits } = await resilience.circuits({
      ...(this.status !== undefined ? { status: this.status as CircuitStatus } : {}),
      ...(this.store !== undefined ? { store: this.store } : {}),
      first: 1000,
    });
    if (this.json) {
      this.logger.log(JSON.stringify(circuits, null, 2));
      return;
    }
    if (circuits.length === 0) {
      this.logger.info('No circuits.');
      return;
    }
    const table = this.ui.table();
    table.head(['Circuit', 'Status', 'Failures', 'Half-open at', 'Policy', 'Store', 'Scope']);
    for (const c of circuits) {
      table.row([
        c.key,
        c.status,
        String(c.failures),
        c.openUntil ? new Date(c.openUntil).toISOString() : '',
        c.policy ?? '',
        c.store,
        c.scope,
      ]);
    }
    table.render();
  }
}
