import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LucidResilienceStore, RedisResilienceStore, stores } from '../src/index.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid-helpers.js';
import { makeMockRedis } from './redis-helpers.js';

/**
 * A `ResilienceService` resolved while the app is still booting (a class injected into something the
 * app instantiates during boot, e.g. a workflow step discovered by `@adonis-agora/durable`) builds its
 * stores before `app.booted()` runs, so the store thunks take their connections from the container
 * bindings, which already exist at that point.
 */

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

  it('says which provider is missing when the binding does not exist', async () => {
    await expect(stores.redis()({ app: appWith({}) })).rejects.toThrow(/needs the 'redis' service/);
    await expect(stores.lucid()({ app: appWith({}) })).rejects.toThrow(
      /needs the 'lucid.db' service/,
    );
  });
});
