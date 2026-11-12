---
"@adonis-agora/resilience": minor
---

Bulkheads and rate limiters:

- `bulkhead({ key, limit, queue, queueTimeoutMs, leaseMs, store })` caps concurrent calls; extra calls queue or fail with `BulkheadRejectedError` (`reason`: `full`, `queue-full`, `queue-timeout`) and a `bulkhead-rejected` event.
- `rateLimiter({ key, limit, intervalMs, burst, cost, maxWaitMs, store })` is a token bucket; over budget it waits up to `maxWaitMs` or fails with `RateLimitedError` (`retryAfterMs`) and a `rate-limited` event.
- The memory, Redis and Lucid/SQL stores hold bulkhead slots and rate-limiter budgets (`BulkheadStore`, `RateLimitStore`); Redis and Lucid share them across processes. The SQL stores add the `resilience_bulkhead_leases` and `resilience_rate_limits` tables (`BULKHEADS_DDL`, `RATE_LIMITS_DDL`, `RESILIENCE_DDL`; created automatically unless `autoCreateSchema: false`).
- `resilience.bulkheads()`, `getBulkhead()`, `rateLimiters()`, `getRateLimiter()` list them with their live state; `describePolicies()` describes them.
- `runBulkheadStoreContract` / `runRateLimitStoreContract` in `@adonis-agora/resilience/testing`.
- `lucidResilienceStore()` and `redisResilienceStore()` return their concrete store classes.
