---
"@adonis-agora/resilience": minor
---

createdAt / updatedAt for circuits. The SQL circuits table gains nullable `created_at` / `updated_at` (epoch ms, no default, no backfill): set when the circuit is first written and when its state changes, on the statements the breaker already runs (a success on a clean circuit still writes nothing). `CircuitSnapshot` gains optional `createdAt` / `updatedAt` (`Date`), and `CircuitInfo` (`circuits()`, `getCircuit()`) gains `createdAt` / `updatedAt` as ISO strings or `null`; `RateLimiterInfo` exposes the bucket's existing `updated_at` as `updatedAt`. With `autoCreateSchema` the store adds the columns to an existing table; otherwise run `circuitTimestampsDdl()` in a migration — until then the store keeps working without dates and `agora:doctor --deep` warns. The Telescope circuits and rate-limiters tables and `resilience:circuits:show` / `resilience:rate-limiters:show` show the dates.
