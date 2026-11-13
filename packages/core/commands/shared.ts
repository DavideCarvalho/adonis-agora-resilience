import { userInfo } from 'node:os';
import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { ResilienceService } from '../src/resilience_service.js';

/** Who a command acts as in the audit line and the `circuit-reset` event: `cli:<os user>`. */
export function cliActor(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    // containers without a passwd entry
    return 'cli';
  }
}

/** Epoch ms as an ISO date, or empty. */
export function isoOf(ms: number | undefined): string {
  return ms === undefined ? '' : new Date(ms).toISOString();
}

/**
 * Base for the `resilience:*` commands: boots the app (no worker, no server), resolves the
 * {@link ResilienceService} the dev tools and the telescope page use, and turns a refused input
 * (unknown store, missing key) into one error line and exit code 1.
 */
export abstract class ResilienceCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  override async completed() {
    const error = this.error as unknown;
    if (
      error instanceof Error &&
      !(error instanceof TypeError) &&
      !(error instanceof ReferenceError) &&
      !(error instanceof SyntaxError)
    ) {
      this.logger.error(error.message);
      this.exitCode = 1;
      return true;
    }
    return false;
  }

  protected service(): Promise<ResilienceService> {
    return this.app.container.make(ResilienceService);
  }

  /** The `--store` value, checked against config/resilience.ts. */
  protected checkStore(resilience: ResilienceService, store: string | undefined): void {
    if (store !== undefined && !resilience.storeNames().includes(store)) {
      throw new Error(`Unknown resilience store "${store}".`);
    }
  }

  /** `--first` within the service's bounds (1 … 1000). */
  protected checkFirst(first: number | undefined): number {
    const value = first ?? 100;
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw new Error('--first must be an integer between 1 and 1000');
    }
    return value;
  }

  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }

  /** The stores cannot seek: say so when more rows match than `--first` allowed. */
  protected moreHint(hasNext: boolean, first: number): void {
    if (hasNext) {
      this.logger.info(
        `More than ${first} match: narrow with --prefix / --store or raise --first.`,
      );
    }
  }

  /** Whether someone can answer a confirmation prompt. Without a terminal, `--force` is required. */
  protected canPrompt(): boolean {
    return process.stdin.isTTY === true;
  }
}
