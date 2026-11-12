import type { ApplicationService } from '@adonisjs/core/types';
import { InMemoryResilienceStore } from '../breaker/in_memory_store.js';
import { SqlResilienceStore } from '../breaker/sql.js';
import type { ResilienceConfig } from '../define_config.js';
import { describePolicy } from '../describe.js';
import { noopSink, withAmbient } from '../events.js';
import { isBulkheadStore, isRateLimitStore } from '../limits/types.js';
import { ResilienceService } from '../resilience_service.js';
import { storeProviderKind } from '../stores/factory.js';
import { processMemoryStore } from '../stores/resolve.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/resilience';

function configOf(app: ApplicationService): ResilienceConfig {
  return app.config.get<ResilienceConfig>('resilience', {});
}

/** `memory`, `lucid`, `redis`, `custom` or `instance` (an explicit `store`). */
function defaultStoreKind(config: ResilienceConfig): string {
  if (config.store !== undefined)
    return config.store instanceof InMemoryResilienceStore ? 'memory' : 'instance';
  if (config.default === undefined) return 'memory';
  const provider = config.stores?.[config.default];
  if (provider === undefined) return 'missing';
  return storeProviderKind(provider) ?? 'custom';
}

/** Build every named policy without a service, events or I/O, to read what it is made of. */
function buildPolicies(config: ResilienceConfig) {
  const names = Object.keys(config.stores ?? {});
  return Object.entries(config.policies ?? {}).map(([name, factory]) => {
    try {
      const policy = withAmbient(
        {
          sink: noopSink,
          policy: name,
          store: (store) => {
            if (store !== undefined && !names.includes(store)) {
              throw new Error(`store "${store}" is not in config.stores`);
            }
            return processMemoryStore();
          },
        },
        factory,
      );
      return { name, kinds: describePolicy(policy) };
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** The doctor checks of `@adonis-agora/resilience` (ids frozen for 1.x). */
export function resilienceDoctorChecks(): AgoraDoctorCheck[] {
  return [
    {
      id: 'resilience.store',
      lib: 'resilience',
      title: 'Circuit store',
      run(app): AgoraDoctorResult {
        const config = configOf(app);
        const kind = defaultStoreKind(config);
        if (kind === 'missing') {
          return {
            status: 'error',
            message: `config.default is "${config.default}", which is not in config.stores`,
            fix: `Add ${config.default} to stores in config/resilience.ts, or point default at one that is`,
            docs: `${DOCS}/adonis`,
          };
        }
        if (kind === 'memory' && app.inProduction) {
          return {
            status: 'warn',
            message:
              'the default store is the in-memory store: every process has its own circuits, bulkheads and rate budgets',
            fix: 'Use stores.redis() or stores.lucid() as `default` in config/resilience.ts',
            docs: `${DOCS}/stores`,
          };
        }
        return { status: 'ok', message: `default store: ${config.default ?? kind} (${kind})` };
      },
    },
    {
      id: 'resilience.policies',
      lib: 'resilience',
      title: 'Named policies build',
      run(app): AgoraDoctorResult[] {
        const built = buildPolicies(configOf(app));
        if (built.length === 0) return [{ status: 'skip', message: 'no named policies' }];
        const failed = built.filter((b) => b.error !== undefined);
        if (failed.length === 0) {
          return [{ status: 'ok', message: `${built.length} named policies build` }];
        }
        return failed.map((b) => ({
          status: 'error',
          message: `policy "${b.name}" throws when built: ${b.error}`,
          fix: `Fix the "${b.name}" factory under policies in config/resilience.ts`,
          docs: `${DOCS}/adonis`,
        }));
      },
    },
    {
      id: 'resilience.limits-scope',
      lib: 'resilience',
      title: 'Bulkheads and rate limiters are shared',
      run(app): AgoraDoctorResult {
        const config = configOf(app);
        const limited = buildPolicies(config).filter((b) =>
          b.kinds?.some((k) => k.startsWith('bulkhead(') || k.startsWith('rate-limiter(')),
        );
        if (limited.length === 0) return { status: 'skip', message: 'no bulkhead or rate limiter' };
        if (defaultStoreKind(config) === 'memory' && app.inProduction) {
          return {
            status: 'warn',
            message: `${limited.map((b) => b.name).join(', ')} limit per process on the in-memory store: N processes allow N times the limit`,
            fix: 'Give these policies a shared store (Redis or Lucid), or make one the default',
            docs: `${DOCS}/policies#bulkhead`,
          };
        }
        return {
          status: 'ok',
          message: `${limited.length} policies with bulkheads or rate limiters`,
        };
      },
    },
    {
      id: 'resilience.store-reachable',
      lib: 'resilience',
      title: 'Stores answer',
      cost: 'deep',
      async run(app): Promise<AgoraDoctorResult[]> {
        const service = await app.container.make(ResilienceService);
        const names = service.storeNames();
        const targets = names.length > 0 ? names : [undefined];
        const out: AgoraDoctorResult[] = [];
        for (const name of targets) {
          const store = service.circuitStore(name);
          const label = name ?? 'default';
          try {
            await store.snapshot('__doctor__');
            if (isBulkheadStore(store)) await store.bulkheadSnapshot('__doctor__');
            if (isRateLimitStore(store)) await store.rateLimitSnapshot('__doctor__');
            const report =
              store instanceof SqlResilienceStore ? await store.inspectSchema() : undefined;
            if (report === undefined) {
              out.push({ status: 'ok', message: `${label} answers` });
            } else if (!report.exists || report.missingTables.length > 0 || !report.writable) {
              out.push({
                status: 'error',
                message: !report.exists
                  ? `${label}: schema "${report.schema}" does not exist`
                  : report.missingTables.length > 0
                    ? `${label}: ${report.missingTables.join(', ')} not in schema "${report.schema}"`
                    : `${label}: cannot write to schema "${report.schema}": ${report.writeError}`,
                fix: report.writable
                  ? `Create the schema and tables (resilienceDdl({ schema: '${report.schema}' })), or leave autoCreateSchema on`
                  : `Grant the connection's role USAGE on schema "${report.schema}" and INSERT/UPDATE/DELETE on its resilience tables`,
                docs: `${DOCS}/stores`,
              });
            } else {
              out.push({
                status: 'ok',
                message: `${label} answers (tables in schema "${report.schema}", writable)`,
              });
            }
          } catch (error) {
            out.push({
              status: 'error',
              message: `${label} does not answer: ${error instanceof Error ? error.message : String(error)}`,
              fix: 'Check the connection, and that the resilience tables exist (RESILIENCE_DDL) when autoCreateSchema is false',
              docs: `${DOCS}/stores`,
            });
          }
        }
        return out;
      },
    },
  ];
}
