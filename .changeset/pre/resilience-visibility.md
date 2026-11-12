---
"@adonis-agora/resilience": minor
---

See what your policies are doing:

- Every event of a named policy carries `policy` (retry, timeout and failover events included).
- New `executedEvents: true` option: one `executed` event (`{ policy, ok, ms, attempts, error? }`) per call to a named policy.
- New `circuit-reset` event, emitted (with an audit log line) by the new `resilience.resetCircuit(key, { store, by, via })` and by `circuit(key).reset()`.
- `resilience.circuits({ store, status, prefix, limit })`, `getCircuit(key, store)`, `policyNames()`, `describePolicies()` and `recentEvents({ type, key, policy, limit })`.
- Stores gain an optional `keys({ prefix, limit })`, implemented by the memory, Redis and Lucid/SQL stores.
- `circuitBreaker({ store })` accepts a store name from config, or no store at all (the default store inside a named policy, a shared in-memory store otherwise).
- Typed `agora:resilience:*` channels for `@adonis-agora/diagnostics` (`ResilienceChannels`).
