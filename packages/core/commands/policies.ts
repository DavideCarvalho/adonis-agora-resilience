import { ResilienceCommand } from './shared.js';

/** `node ace resilience:policies:list [--json]` — the named policies and what each is made of. */
export class ResiliencePoliciesList extends ResilienceCommand {
  static override commandName = 'resilience:policies:list';
  static override description = 'List the named policies from config/resilience.ts';

  declare json?: boolean;

  static {
    ResiliencePoliciesList.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const policies = (await this.service()).describePolicies();
    // A policy whose factory throws is a failure, in the table and in JSON alike.
    if (policies.some((p) => p.error)) this.exitCode = 1;
    if (this.json) return this.printJson({ data: policies });
    if (policies.length === 0) {
      this.logger.info('No named policies.');
      return;
    }
    const table = this.ui.table();
    table.head(['Policy', 'Made of']);
    for (const p of policies) {
      table.row([p.name, p.error ? `error: ${p.error}` : p.kinds.join(', ')]);
    }
    table.render();
  }
}
