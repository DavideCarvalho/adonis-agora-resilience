import type { CircuitStatus } from '../src/breaker/types.js';
import { cliActor, isoOf, ResilienceCommand } from './shared.js';

const STATUSES: readonly CircuitStatus[] = ['closed', 'open', 'half-open'];

/**
 * `node ace resilience:circuits:list [--status=open] [--store=redis] [--prefix=pay] [--first=100]
 * [--json]` — circuit breakers with their live state, open first.
 */
export class ResilienceCircuitsList extends ResilienceCommand {
  static override commandName = 'resilience:circuits:list';
  static override description = 'List circuit breakers and their live state, open first';

  declare status?: string;
  declare store?: string;
  declare prefix?: string;
  declare first?: number;
  declare json?: boolean;

  static {
    ResilienceCircuitsList.defineFlag('status', {
      type: 'string',
      description: 'Only circuits in this state (closed, open, half-open)',
    });
    ResilienceCircuitsList.defineFlag('store', {
      type: 'string',
      description: 'Only this store (a name from config/resilience.ts)',
    });
    ResilienceCircuitsList.defineFlag('prefix', {
      type: 'string',
      description: 'Only keys starting with this',
    });
    ResilienceCircuitsList.defineFlag('first', {
      type: 'number',
      description: 'How many circuits (default 100, at most 1000)',
    });
    ResilienceCircuitsList.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    if (this.status !== undefined && !STATUSES.includes(this.status as CircuitStatus)) {
      throw new Error('--status must be closed, open or half-open');
    }
    const first = this.checkFirst(this.first);
    const resilience = await this.service();
    this.checkStore(resilience, this.store);
    const page = await resilience.circuits({
      ...(this.status !== undefined ? { status: this.status as CircuitStatus } : {}),
      ...(this.store !== undefined ? { store: this.store } : {}),
      ...(this.prefix !== undefined ? { prefix: this.prefix } : {}),
      first,
    });
    if (this.json) return this.printJson(page);
    if (page.data.length === 0) {
      this.logger.info('No circuits.');
      return;
    }
    const table = this.ui.table();
    table.head(['Circuit', 'Status', 'Failures', 'Half-open at', 'Policy', 'Store', 'Scope']);
    for (const c of page.data) {
      table.row([
        c.key,
        c.status,
        String(c.failures),
        isoOf(c.openUntil),
        c.policy ?? '',
        c.store,
        c.scope,
      ]);
    }
    table.render();
    this.moreHint(page.meta.hasNext, first);
  }
}

/** `node ace resilience:circuits:show <key> [--store=redis] [--json]` — one circuit's live state. */
export class ResilienceCircuitsShow extends ResilienceCommand {
  static override commandName = 'resilience:circuits:show';
  static override description = 'Show one circuit breaker and its live state';

  declare key: string;
  declare store?: string;
  declare json?: boolean;

  static {
    ResilienceCircuitsShow.defineArgument('key', {
      type: 'string',
      description: 'The circuit key',
    });
    ResilienceCircuitsShow.defineFlag('store', {
      type: 'string',
      description: 'A store name from config/resilience.ts (default: the default store)',
    });
    ResilienceCircuitsShow.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const resilience = await this.service();
    this.checkStore(resilience, this.store);
    const circuit = await resilience.getCircuit(this.key, this.store);
    if (this.json) return this.printJson(circuit);
    const table = this.ui.table();
    table.head(['Field', 'Value']);
    table.row(['Circuit', circuit.key]);
    table.row(['Status', circuit.status]);
    table.row(['Failures', String(circuit.failures)]);
    if (circuit.threshold !== undefined) table.row(['Threshold', String(circuit.threshold)]);
    if (circuit.cooldownMs !== undefined) table.row(['Cooldown', `${circuit.cooldownMs}ms`]);
    if (circuit.openUntil !== undefined) table.row(['Half-open at', isoOf(circuit.openUntil)]);
    table.row(['Policy', circuit.policy ?? '']);
    table.row(['Store', circuit.store]);
    table.row(['Scope', circuit.scope]);
    table.render();
  }
}

/**
 * `node ace resilience:circuits:reset <key> [--store=redis] [--force]` — force a circuit back to
 * closed. Asks first unless `--force` (and refuses without a terminal). Logs the audit line and
 * emits `circuit-reset` with `by: 'cli:<os user>'`, `via: 'cli'`.
 */
export class ResilienceCircuitsReset extends ResilienceCommand {
  static override commandName = 'resilience:circuits:reset';
  static override description = 'Force a circuit breaker back to closed';

  declare key: string;
  declare store?: string;
  declare force?: boolean;
  declare json?: boolean;

  static {
    ResilienceCircuitsReset.defineArgument('key', {
      type: 'string',
      description: 'The circuit key',
    });
    ResilienceCircuitsReset.defineFlag('store', {
      type: 'string',
      description: 'A store name from config/resilience.ts (default: the default store)',
    });
    ResilienceCircuitsReset.defineFlag('force', {
      type: 'boolean',
      description: 'Do not ask for confirmation',
    });
    ResilienceCircuitsReset.defineFlag('json', {
      type: 'boolean',
      description: 'Print the circuit after the reset as JSON',
    });
  }

  override async run(): Promise<void> {
    const resilience = await this.service();
    this.checkStore(resilience, this.store);
    const before = await resilience.getCircuit(this.key, this.store);
    if (!this.force) {
      if (!this.canPrompt()) {
        throw new Error(
          'Resetting a circuit needs confirmation: run it in a terminal or pass --force.',
        );
      }
      const confirmed = await this.prompt.confirm(
        `Reset circuit "${before.key}" (${before.store}, ${before.status})? It closes now and calls go through to the dependency again.`,
      );
      if (!confirmed) {
        this.logger.warning('Cancelled.');
        this.exitCode = 1;
        return;
      }
    }
    const after = await resilience.resetCircuit(this.key, {
      ...(this.store !== undefined ? { store: this.store } : {}),
      by: cliActor(),
      via: 'cli',
    });
    if (this.json) return this.printJson(after);
    this.logger.success(
      `Circuit "${after.key}" on ${after.store} is ${after.status} (was ${before.status}).`,
    );
  }
}
