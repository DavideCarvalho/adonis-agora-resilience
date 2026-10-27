---
"@adonis-agora/resilience": patch
---

Keep healthy circuits off the lock. The SQL (Lucid) store now answers `admit` from a plain read unless the decision changes the circuit (open to half-open, or granting a probe), and records a non-probe success as one conditional `UPDATE` that writes nothing when the circuit is already closed with no failures; failures and probe outcomes still run in the locked transaction. A wrapped call on a closed circuit drops from two transactions (ten round trips) to two plain statements. `SqlDriver` gains an optional `run()` for that non-transactional write (falls back to a one-statement transaction when absent). The Redis record script skips its `HSET` (and TTL refresh) when the circuit is already clean. `delay()` on both clocks removes its abort listener when the delay elapses, so `retry` no longer leaves one listener per attempt on the caller's signal.
