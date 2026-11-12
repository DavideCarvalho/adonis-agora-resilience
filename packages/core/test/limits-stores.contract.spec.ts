import {
  InMemoryResilienceStore,
  lucidResilienceStore,
  redisResilienceStore,
} from '../src/index.js';
import { runBulkheadStoreContract, runRateLimitStoreContract } from '../src/testing.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid-helpers.js';
import { makeMockRedis } from './redis-helpers.js';

// Each case gets a fresh store (isolated in-memory sqlite / isolated ioredis-mock server).
runBulkheadStoreContract('InMemoryResilienceStore', (clock) => new InMemoryResilienceStore(clock));
runRateLimitStoreContract('InMemoryResilienceStore', (clock) => new InMemoryResilienceStore(clock));

runBulkheadStoreContract('LucidResilienceStore', (clock) =>
  lucidResilienceStore(asLucidDatabase(makeMemoryDatabase()), { clock }),
);
runRateLimitStoreContract('LucidResilienceStore', (clock) =>
  lucidResilienceStore(asLucidDatabase(makeMemoryDatabase()), { clock }),
);

runBulkheadStoreContract('RedisResilienceStore', (clock) =>
  redisResilienceStore(makeMockRedis(), { clock }),
);
runRateLimitStoreContract('RedisResilienceStore', (clock) =>
  redisResilienceStore(makeMockRedis(), { clock }),
);
