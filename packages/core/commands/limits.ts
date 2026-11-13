import { ResilienceCommand } from './shared.js';

function rateOf(limit: number | undefined, intervalMs: number | undefined): string {
  return limit !== undefined && intervalMs !== undefined ? `${limit}/${intervalMs}ms` : '';
}

/** `node ace resilience:bulkheads:list [--store] [--prefix] [--first] [--json]` — busiest first. */
export class ResilienceBulkheadsList extends ResilienceCommand {
  static override commandName = 'resilience:bulkheads:list';
  static override description = 'List bulkheads with the calls running now, busiest first';

  declare store?: string;
  declare prefix?: string;
  declare first?: number;
  declare json?: boolean;

  static {
    ResilienceBulkheadsList.defineFlag('store', {
      type: 'string',
      description: 'Only this store (a name from config/resilience.ts)',
    });
    ResilienceBulkheadsList.defineFlag('prefix', {
      type: 'string',
      description: 'Only keys starting with this',
    });
    ResilienceBulkheadsList.defineFlag('first', {
      type: 'number',
      description: 'How many bulkheads (default 100, at most 1000)',
    });
    ResilienceBulkheadsList.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const first = this.checkFirst(this.first);
    const resilience = await this.service();
    this.checkStore(resilience, this.store);
    const page = await resilience.bulkheads({
      ...(this.store !== undefined ? { store: this.store } : {}),
      ...(this.prefix !== undefined ? { prefix: this.prefix } : {}),
      first,
    });
    if (this.json) return this.printJson(page);
    if (page.data.length === 0) {
      this.logger.info('No bulkheads.');
      return;
    }
    const table = this.ui.table();
    table.head(['Bulkhead', 'Running', 'Limit', 'Policy', 'Store', 'Scope']);
    for (const b of page.data) {
      table.row([
        b.key,
        String(b.active),
        b.limit === undefined ? '' : String(b.limit),
        b.policy ?? '',
        b.store,
        b.scope,
      ]);
    }
    table.render();
    this.moreHint(page.meta.hasNext, first);
  }
}

/** `node ace resilience:bulkheads:show <key> [--store] [--json]` — one bulkhead's occupancy. */
export class ResilienceBulkheadsShow extends ResilienceCommand {
  static override commandName = 'resilience:bulkheads:show';
  static override description = 'Show one bulkhead and the calls running now';

  declare key: string;
  declare store?: string;
  declare json?: boolean;

  static {
    ResilienceBulkheadsShow.defineArgument('key', {
      type: 'string',
      description: 'The bulkhead key',
    });
    ResilienceBulkheadsShow.defineFlag('store', {
      type: 'string',
      description: 'A store name from config/resilience.ts (default: the default store)',
    });
    ResilienceBulkheadsShow.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const resilience = await this.service();
    this.checkStore(resilience, this.store);
    const bulkhead = await resilience.getBulkhead(this.key, this.store);
    if (this.json) return this.printJson(bulkhead);
    const table = this.ui.table();
    table.head(['Field', 'Value']);
    table.row(['Bulkhead', bulkhead.key]);
    table.row(['Running', String(bulkhead.active)]);
    if (bulkhead.limit !== undefined) table.row(['Limit', String(bulkhead.limit)]);
    if (bulkhead.queue !== undefined) table.row(['Queue', String(bulkhead.queue)]);
    table.row(['Policy', bulkhead.policy ?? '']);
    table.row(['Store', bulkhead.store]);
    table.row(['Scope', bulkhead.scope]);
    table.render();
  }
}

/** `node ace resilience:rate-limiters:list [--store] [--prefix] [--first] [--json]` — emptiest first. */
export class ResilienceRateLimitersList extends ResilienceCommand {
  static override commandName = 'resilience:rate-limiters:list';
  static override description = 'List rate limiters with the budget left, emptiest first';

  declare store?: string;
  declare prefix?: string;
  declare first?: number;
  declare json?: boolean;

  static {
    ResilienceRateLimitersList.defineFlag('store', {
      type: 'string',
      description: 'Only this store (a name from config/resilience.ts)',
    });
    ResilienceRateLimitersList.defineFlag('prefix', {
      type: 'string',
      description: 'Only keys starting with this',
    });
    ResilienceRateLimitersList.defineFlag('first', {
      type: 'number',
      description: 'How many rate limiters (default 100, at most 1000)',
    });
    ResilienceRateLimitersList.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const first = this.checkFirst(this.first);
    const resilience = await this.service();
    this.checkStore(resilience, this.store);
    const page = await resilience.rateLimiters({
      ...(this.store !== undefined ? { store: this.store } : {}),
      ...(this.prefix !== undefined ? { prefix: this.prefix } : {}),
      first,
    });
    if (this.json) return this.printJson(page);
    if (page.data.length === 0) {
      this.logger.info('No rate limiters.');
      return;
    }
    const table = this.ui.table();
    table.head(['Limiter', 'Left', 'Rate', 'Policy', 'Store', 'Scope']);
    for (const r of page.data) {
      table.row([
        r.key,
        r.remaining === undefined
          ? r.tokens === undefined
            ? ''
            : String(Math.floor(r.tokens))
          : String(r.remaining),
        rateOf(r.limit, r.intervalMs),
        r.policy ?? '',
        r.store,
        r.scope,
      ]);
    }
    table.render();
    this.moreHint(page.meta.hasNext, first);
  }
}

/** `node ace resilience:rate-limiters:show <key> [--store] [--json]` — one limiter's budget. */
export class ResilienceRateLimitersShow extends ResilienceCommand {
  static override commandName = 'resilience:rate-limiters:show';
  static override description = 'Show one rate limiter and the budget left';

  declare key: string;
  declare store?: string;
  declare json?: boolean;

  static {
    ResilienceRateLimitersShow.defineArgument('key', {
      type: 'string',
      description: 'The rate limiter key',
    });
    ResilienceRateLimitersShow.defineFlag('store', {
      type: 'string',
      description: 'A store name from config/resilience.ts (default: the default store)',
    });
    ResilienceRateLimitersShow.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const resilience = await this.service();
    this.checkStore(resilience, this.store);
    const limiter = await resilience.getRateLimiter(this.key, this.store);
    if (this.json) return this.printJson(limiter);
    const table = this.ui.table();
    table.head(['Field', 'Value']);
    table.row(['Limiter', limiter.key]);
    if (limiter.remaining !== undefined) table.row(['Left', String(limiter.remaining)]);
    if (limiter.tokens !== undefined) table.row(['Tokens', String(limiter.tokens)]);
    if (limiter.limit !== undefined) table.row(['Rate', rateOf(limiter.limit, limiter.intervalMs)]);
    if (limiter.burst !== undefined) table.row(['Burst', String(limiter.burst)]);
    table.row(['Policy', limiter.policy ?? '']);
    table.row(['Store', limiter.store]);
    table.row(['Scope', limiter.scope]);
    table.render();
  }
}
