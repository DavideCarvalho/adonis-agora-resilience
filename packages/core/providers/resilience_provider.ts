import type { ApplicationService } from '@adonisjs/core/types';
import type { ResilienceStore } from '../src/breaker/store.js';
import type { ResilienceConfig } from '../src/define_config.js';
import { registerDevTools } from '../src/dev_tools/tools.js';
import { registerDoctorChecks } from '../src/doctor/agora_doctor.js';
import { resilienceDoctorChecks } from '../src/doctor/checks.js';
import { ResilienceService } from '../src/resilience_service.js';
import { resilienceTelescopeExtension } from '../src/telescope/extension.js';
import { type ExtensionsContainer, registerTelescopeExtension } from '../src/telescope/register.js';

/**
 * Wires `@adonis-agora/resilience` into the AdonisJS application: binds a singleton
 * {@link ResilienceService} built from `config/resilience.ts`.
 *
 * ```ts
 * const resilience = await app.container.make(ResilienceService)
 * await resilience.execute('db', () => query())
 * ```
 *
 * The binding factory is lazy and async, so config is read on first resolve (after the config
 * phase). On first resolve it builds every store listed in `config.stores` (each thunk imports its
 * peer dependency — `@adonisjs/lucid`, `@adonisjs/redis` — as it is built); `config.default` then
 * selects which of those built stores is the circuit store. A peer you never list is never
 * imported. An explicit `config.store` still wins when provided.
 */
export default class ResilienceProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    void registerDoctorChecks(this.app.container as never, resilienceDoctorChecks());

    const telescope = this.app.config.get<ResilienceConfig['telescope']>(
      'resilience.telescope',
      true,
    );
    if (telescope !== false) {
      registerTelescopeExtension(
        this.app.container as unknown as ExtensionsContainer,
        resilienceTelescopeExtension(typeof telescope === 'object' ? telescope : {}),
      );
    }

    this.app.container.singleton(ResilienceService, async () => {
      const config = this.app.config.get<ResilienceConfig>('resilience', {});
      const {
        default: defaultStore,
        stores: providers,
        store,
        telescope: _telescope,
        devTools: _devTools,
        ...rest
      } = config;

      // Build every configured store thunk once, resolving its (optional) peer dependency.
      const resolved: Record<string, ResilienceStore> = {};
      if (providers) {
        for (const [name, provider] of Object.entries(providers)) {
          resolved[name] = await provider({ app: this.app });
        }
      }

      if (defaultStore && !providers?.[defaultStore]) {
        throw new Error(
          `@adonis-agora/resilience: config.default is "${defaultStore}", but config.stores.${defaultStore} is not defined`,
        );
      }

      const logger = await this.app.container.make('logger').catch(() => undefined);
      return new ResilienceService({
        ...rest,
        ...(logger ? { logger } : {}),
        ...(store !== undefined ? { store } : {}),
        ...(defaultStore !== undefined ? { defaultStore } : {}),
        stores: resolved,
      });
    });
  }

  /**
   * Registers the resilience developer tools on the agent's dev MCP endpoint (`/mcp/agora`) when
   * `@adonis-agora/agent`'s MCP provider is installed. `devTools: false` in config/resilience.ts
   * leaves them out.
   */
  async boot() {
    if (this.app.config.get<boolean>('resilience.devTools', true) === false) return;
    const outcome = await registerDevTools(this.app.container as never, () =>
      this.app.container.make(ResilienceService),
    );
    if (outcome === 'unsupported' || outcome === 'failed') {
      const logger = (await this.app.container.make('logger').catch(() => undefined)) as
        | { debug(msg: string): void }
        | undefined;
      logger?.debug(
        outcome === 'unsupported'
          ? '[@adonis-agora/resilience] dev tools not registered: the installed @adonis-agora/agent cannot gate libs without a console (needs devTools.authorize support)'
          : '[@adonis-agora/resilience] dev tools could not be registered',
      );
    }
  }
}
