import { describe, expect, it } from 'vitest';
import { defineConfig, stores } from '../src/index.js';
import { describeConfiguredStores, STACK_DESCRIPTOR } from '../src/stores/stack.js';

const usesOf = (value: unknown): unknown => (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];

function appConfig(values: Record<string, unknown>) {
  return {
    get(key: string) {
      let v: unknown = values;
      for (const part of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[part];
      return v;
    },
  };
}

describe('stack descriptor', () => {
  it('describes the Redis and Lucid stores, non-enumerable, and not the memory one', () => {
    const redis = stores.redis({ connection: 'cache' });
    const lucid = stores.lucid({ connection: 'pg' });
    expect(usesOf(redis)).toEqual([
      { tech: 'redis', connection: 'cache', purpose: 'breaker state' },
    ]);
    expect(usesOf(lucid)).toEqual([{ tech: 'sql', connection: 'pg', purpose: 'breaker state' }]);
    expect(usesOf(stores.memory())).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(redis, STACK_DESCRIPTOR)?.enumerable).toBe(false);
  });

  it('describes an unset Redis connection as `main` before the app resolves it', () => {
    expect(usesOf(stores.redis())).toEqual([
      { tech: 'redis', connection: 'main', purpose: 'breaker state' },
    ]);
  });

  it('resolves the default connections and the Lucid client from the app config', () => {
    const config = defineConfig({
      default: 'redis',
      stores: { redis: stores.redis(), lucid: stores.lucid(), memory: stores.memory() },
    });
    describeConfiguredStores(
      config.stores,
      appConfig({
        redis: { connection: 'shared' },
        database: { connection: 'educacao', connections: { educacao: { client: 'pg' } } },
      }),
    );
    expect(usesOf(config.stores?.redis)).toEqual([
      { tech: 'redis', connection: 'shared', purpose: 'breaker state' },
    ]);
    expect(usesOf(config.stores?.lucid)).toEqual([
      { tech: 'postgres', connection: 'educacao', purpose: 'breaker state' },
    ]);
  });
});
