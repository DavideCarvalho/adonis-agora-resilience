import { InMemoryResilienceStore } from './in_memory_store';
import { runResilienceStoreContract } from './store_contract';

runResilienceStoreContract(
  'InMemoryResilienceStore',
  (clock) => new InMemoryResilienceStore(clock),
);
