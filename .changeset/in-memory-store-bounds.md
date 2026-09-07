---
'@adonis-agora/resilience': patch
---

`InMemoryResilienceStore` accepts optional `maxEntries` (LRU eviction) and `ttlMs` (lazy per-key expiry) options, and `stores.memory()` forwards them. Previously the store's internal map only shrank via an explicit `reset(key)`, so an app that composes a circuit `key` from caller-influenced input (e.g. the documented tenant-scoping pattern) had no way to bound its memory growth. Both default to unbounded, matching prior behavior.
