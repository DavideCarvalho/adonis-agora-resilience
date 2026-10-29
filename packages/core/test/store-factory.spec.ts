import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LucidResilienceStore, RedisResilienceStore, stores } from '../src/index.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid-helpers.js';
import { makeMockRedis } from './redis-helpers.js';

/**
 * A `ResilienceService` resolved while the app is still booting (a class injected into something the
 * app instantiates during boot, e.g. a workflow step discovered by `@adonis-agora/durable`) builds its
 * stores before `app.booted()` runs. At that point `@adonisjs/redis/services/main` and
 * `@adonisjs/lucid/services/db` still export `undefined`: the store thunks read them and failed with
 * "Cannot read properties of undefined (reading 'connection')". The container bindings already exist,
 * so the thunks resolve those first.
 */

// The service modules as they are before `app.booted()`: their default export is still undefined.
vi.mock('@adonisjs/redis/services/main', () => ({ default: undefined }));
vi.mock('@adonisjs/lucid/services/db', () => ({ default: undefined }));

function appWith(bindings: Record<string, unknown>): ApplicationService {
  return {
    container: {
      make: async (binding: string) => {
        if (binding in bindings) return bindings[binding];
        throw new Error(`Cannot resolve "${binding}"`);
      },
    },
  } as unknown as ApplicationService;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('store factories during boot', () => {
  it('redis(): takes the connection from the container binding', async () => {
    const ioConnection = makeMockRedis();
    const connection = vi.fn((_name?: string) => ({ ioConnection }));
    const store = await stores.redis({ connection: 'main' })({
      app: appWith({ redis: { connection } }),
    });
    expect(store).toBeInstanceOf(RedisResilienceStore);
    expect(connection).toHaveBeenCalledWith('main');
  });

  it('lucid(): takes the database from the container binding', async () => {
    const db = asLucidDatabase(makeMemoryDatabase());
    const connection = vi.fn((_name: string) => db);
    const store = await stores.lucid({ connection: 'pg' })({
      app: appWith({ 'lucid.db': { connection } }),
    });
    expect(store).toBeInstanceOf(LucidResilienceStore);
    expect(connection).toHaveBeenCalledWith('pg');
  });

  it('says which provider is missing when neither the binding nor the service exists', async () => {
    await expect(stores.redis()({ app: appWith({}) })).rejects.toThrow(/needs the 'redis' service/);
  });

  it('says which provider is missing when the peer package is not installed', async () => {
    vi.doMock('@adonisjs/lucid/services/db', () => {
      throw new Error("Cannot find package '@adonisjs/lucid'");
    });
    await expect(stores.lucid()({ app: appWith({}) })).rejects.toThrow(
      /needs the 'lucid.db' service/,
    );
    vi.doUnmock('@adonisjs/lucid/services/db');
  });
});
