/**
 * What the circuit stores run on, for telescope's Architecture page ("resilience: breaker state →
 * Redis main"). Telescope reads `config/resilience.ts` after boot and looks for a list of uses under
 * the global symbol `@adonis-agora/stack` on each store factory. No dependency on telescope.
 */

/** The symbol telescope reads a lib's infrastructure under. */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

/** What a store uses (the shape telescope reads). */
export interface StackUse {
  tech: string;
  connection?: string;
  purpose?: string;
  label?: string;
  host?: string;
}

/** Attach `uses` to `target`, non-enumerable. Never throws (a frozen object stays undescribed). */
export function describeStackUse<T extends object>(target: T, uses: StackUse | StackUse[]): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      value: Array.isArray(uses) ? uses : [uses],
      enumerable: false,
      configurable: true,
    });
  } catch {
    // frozen: nothing to describe
  }
  return target;
}

/** A store factory's backend, before the app's config resolves its default connection. */
export interface StoreStackHint {
  kind: 'lucid' | 'redis';
  connection?: string | undefined;
}

interface AppConfigLike {
  get(key: string, defaultValue?: unknown): unknown;
}

const PURPOSE = 'breaker state';

const DB_TECH: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  'pg-native': 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  libsql: 'sqlite',
  mssql: 'mssql',
};

const hints = new WeakMap<object, StoreStackHint>();

function read(appConfig: AppConfigLike | undefined, key: string): unknown {
  try {
    return appConfig?.get(key);
  } catch {
    return undefined;
  }
}

/**
 * What a store with `hint` uses. `appConfig` (the app's config) resolves an unset connection to the
 * app's default one and a Lucid connection's client to its technology; without it a Redis store
 * defaults to `main` and an unset Lucid connection stays unnamed.
 */
export function storeStackUse(hint: StoreStackHint, appConfig?: AppConfigLike): StackUse {
  if (hint.kind === 'redis') {
    const fallback = read(appConfig, 'redis.connection');
    const connection = hint.connection ?? (typeof fallback === 'string' ? fallback : 'main');
    return { tech: 'redis', connection, purpose: PURPOSE };
  }
  const fallback = read(appConfig, 'database.connection');
  const connection = hint.connection ?? (typeof fallback === 'string' ? fallback : undefined);
  const client =
    connection !== undefined
      ? read(appConfig, `database.connections.${connection}.client`)
      : undefined;
  const tech = (typeof client === 'string' ? DB_TECH[client] : undefined) ?? 'sql';
  return { tech, ...(connection !== undefined ? { connection } : {}), purpose: PURPOSE };
}

/** Describe `factory` as a store on `hint`'s backend, and remember the hint. Returns `factory`. */
export function describeStore<T extends object>(factory: T, hint: StoreStackHint): T {
  hints.set(factory, hint);
  return describeStackUse(factory, storeStackUse(hint));
}

/**
 * Describe every store of `config/resilience.ts` again with the app's defaults resolved (the
 * provider calls it at register, before telescope reads the config).
 */
export function describeConfiguredStores(stores: unknown, appConfig: AppConfigLike): void {
  if (stores === null || typeof stores !== 'object') return;
  for (const factory of Object.values(stores as Record<string, unknown>)) {
    if (factory === null || (typeof factory !== 'object' && typeof factory !== 'function'))
      continue;
    const hint = hints.get(factory);
    if (hint) describeStackUse(factory, storeStackUse(hint, appConfig));
  }
}
