import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { ResilienceService } from '../src/resilience_service.js';

/**
 * `node ace resilience:reset <key> [--store=redis]` — force a circuit breaker back to closed. Logs an
 * audit line and emits `circuit-reset` (`by: 'cli'`).
 */
export default class ResilienceReset extends BaseCommand {
  static override commandName = 'resilience:reset';
  static override description = 'Force a circuit breaker back to closed';
  static override options: CommandOptions = { startApp: true };

  declare key: string;
  declare store?: string;

  static {
    ResilienceReset.defineArgument('key', { type: 'string', description: 'The circuit key' });
    ResilienceReset.defineFlag('store', {
      type: 'string',
      description: 'A store name from config/resilience.ts (default: the default store)',
    });
  }

  override async run(): Promise<void> {
    const resilience = await this.app.container.make(ResilienceService);
    if (this.store !== undefined && !resilience.storeNames().includes(this.store)) {
      this.logger.error(`Unknown resilience store "${this.store}".`);
      this.exitCode = 1;
      return;
    }
    const before = await resilience.getCircuit(this.key, this.store);
    const after = await resilience.resetCircuit(this.key, {
      ...(this.store !== undefined ? { store: this.store } : {}),
      by: 'cli',
      via: 'cli',
    });
    this.logger.success(
      `Circuit "${after.key}" on ${after.store} is ${after.status} (was ${before.status}).`,
    );
  }
}
