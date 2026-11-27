---
'@adonis-agora/resilience': patch
---

Fix the `withResilience` JSDoc: a decorated `circuitBreaker` does not need an explicit `store`. Without one it uses the shared process-wide in-memory store. A store name throws at decoration time. Pass a store instance when breaker state must be shared across processes.
