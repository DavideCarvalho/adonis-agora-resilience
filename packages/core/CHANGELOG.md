# @adonis-agora/resilience

## 1.0.0-rc.4

### Minor Changes

- [#146](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/146) [`c6c2470`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/c6c2470de2bcc3d1fc0d43ddb95ea2b41740dfc6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Developer tools and commands:
  
  - With `@adonis-agora/agent`'s MCP provider installed, resilience registers its tools on the dev MCP endpoint (`/mcp/agora`), gated by the endpoint's `devTools.authorize`: `resilience_list_policies`, `resilience_list_circuits`, `resilience_get_circuit`, `resilience_list_bulkheads`, `resilience_list_rate_limiters`, `resilience_list_recent_events` and the action `resilience_reset_circuit` (audited with the caller). `devTools: false` in `config/resilience.ts` leaves them out.
  - New ace commands `resilience:circuits` (`--status`, `--store`, `--json`) and `resilience:reset <key>` (`--store`), exported as `@adonis-agora/resilience/commands` and registered by `configure`. Existing apps add `() => import('@adonis-agora/resilience/commands')` to `commands` in `adonisrc.ts`.

## 1.0.0-rc.3

### Minor Changes

- [#145](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/145) [`bda80f3`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/bda80f3f95226bdc8ade9be6c626a3d70933b053) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A "Resilience" page in `@adonis-agora/telescope`, added automatically when telescope is installed (through the `agora.telescope.extensions` container value): open and half-open circuits, short-circuits, retries, timeouts, error rate, bulkhead rejections and rate-limited calls of the last hour, the circuits / bulkheads / rate-limiters tables, events over time, the noisiest policies and recent transitions. Open circuits have a Reset button (confirmation, telescope console `authorize`, audit line and `circuit-reset` event with the acting user). `@adonis-agora/resilience/telescope` exports `resilienceTelescopeExtension()` for manual wiring; `telescope: false` or `telescope: { reset: false }` in `config/resilience.ts` opt out.

## 1.0.0-rc.2

### Minor Changes

- [#144](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/144) [`1c59170`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/1c5917091465e01982140e438322c631f936610b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Bulkheads and rate limiters:
  
  - `bulkhead({ key, limit, queue, queueTimeoutMs, leaseMs, store })` caps concurrent calls; extra calls queue or fail with `BulkheadRejectedError` (`reason`: `full`, `queue-full`, `queue-timeout`) and a `bulkhead-rejected` event.
  - `rateLimiter({ key, limit, intervalMs, burst, cost, maxWaitMs, store })` is a token bucket; over budget it waits up to `maxWaitMs` or fails with `RateLimitedError` (`retryAfterMs`) and a `rate-limited` event.
  - The memory, Redis and Lucid/SQL stores hold bulkhead slots and rate-limiter budgets (`BulkheadStore`, `RateLimitStore`); Redis and Lucid share them across processes. The SQL stores add the `resilience_bulkhead_leases` and `resilience_rate_limits` tables (`BULKHEADS_DDL`, `RATE_LIMITS_DDL`, `RESILIENCE_DDL`; created automatically unless `autoCreateSchema: false`).
  - `resilience.bulkheads()`, `getBulkhead()`, `rateLimiters()`, `getRateLimiter()` list them with their live state; `describePolicies()` describes them.
  - `runBulkheadStoreContract` / `runRateLimitStoreContract` in `@adonis-agora/resilience/testing`.
  - `lucidResilienceStore()` and `redisResilienceStore()` return their concrete store classes.

## 1.0.0-rc.1

### Minor Changes

- [#143](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/143) [`fda0813`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/fda0813aa272320828c74d169202d8fbc9ee1514) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - See what your policies are doing:
  
  - Every event of a named policy carries `policy` (retry, timeout and failover events included).
  - New `executedEvents: true` option: one `executed` event (`{ policy, ok, ms, attempts, error? }`) per call to a named policy.
  - New `circuit-reset` event, emitted (with an audit log line) by the new `resilience.resetCircuit(key, { store, by, via })` and by `circuit(key).reset()`.
  - `resilience.circuits({ store, status, prefix, limit })`, `getCircuit(key, store)`, `policyNames()`, `describePolicies()` and `recentEvents({ type, key, policy, limit })`.
  - Stores gain an optional `keys({ prefix, limit })`, implemented by the memory, Redis and Lucid/SQL stores.
  - `circuitBreaker({ store })` accepts a store name from config, or no store at all (the default store inside a named policy, a shared in-memory store otherwise).
  - Typed `agora:resilience:*` channels for `@adonis-agora/diagnostics` (`ResilienceChannels`).

## 1.0.0-rc.0

### Major Changes

- [#137](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/137) [`7758cf2`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/7758cf2b46a33b4fd8208ef3c25b2c37b2f8c047) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0.0: the API is now stable.
  
  Breaking changes:
  
  - Node.js 24 or newer is required (`"engines": { "node": ">=24" }`).
  - `SqlDriver.run` is required. A custom driver for `SqlResilienceStore` must implement it (a plain write outside a transaction); the fallback that ran the statement in its own transaction is gone.
  - `stores.redis()` and `stores.lucid()` resolve their connection from the `redis` / `lucid.db` container bindings only. The fallback to `@adonisjs/redis/services/main` / `@adonisjs/lucid/services/db` is removed: register `@adonisjs/redis/redis_provider` or `@adonisjs/lucid/database_provider` before the resilience provider.
  
  See [Migrating to 1.0](https://davidecarvalho.github.io/agora/docs/resilience/migrating-to-1.0).

## 0.4.3

### Patch Changes

- [#118](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/118) [`f5f12d8`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/f5f12d84d5c86cc87cbbbeb86745b717d24d3ca2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `stores.redis()` and `stores.lucid()` resolve their connection from the container (`'redis'` / `'lucid.db'`) instead of the `services/main` / `services/db` modules. Those modules only export the service after `app.booted()`, so a `ResilienceService` resolved during boot (injected into a class the app instantiates while booting, such as a discovered `@adonis-agora/durable` step) failed with "Cannot read properties of undefined (reading 'connection')". The service modules remain the fallback when the binding is missing, and a missing peer provider now gets an error that names it.

## 0.4.2

### Patch Changes

- [#116](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/116) [`43c4e22`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/43c4e22c04d0a60513719b1389201c800161901f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - fix(timeout): when the wrapped op throws synchronously, disarm the timeout timer and detach the parent-signal abort listener before rethrowing. Previously the timer stayed armed (emitting a spurious `timeout` event later) and the listener leaked onto the parent signal, accumulating on long-lived signals.

## 0.4.1

### Patch Changes

- [#114](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/114) [`71be346`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/71be346217d3e3a8324fecb2f9735ec9612994e2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Keep healthy circuits off the lock. The SQL (Lucid) store now answers `admit` from a plain read unless the decision changes the circuit (open to half-open, or granting a probe), and records a non-probe success as one conditional `UPDATE` that writes nothing when the circuit is already closed with no failures; failures and probe outcomes still run in the locked transaction. A wrapped call on a closed circuit drops from two transactions (ten round trips) to two plain statements. `SqlDriver` gains an optional `run()` for that non-transactional write (falls back to a one-statement transaction when absent). The Redis record script skips its `HSET` (and TTL refresh) when the circuit is already clean. `delay()` on both clocks removes its abort listener when the delay elapses, so `retry` no longer leaves one listener per attempt on the caller's signal.

## 0.4.0

### Minor Changes

- [#93](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/93) [`a4fd84e`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/a4fd84ede914c8359327a801ab7cf253f6355007) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node.js 20 and 22: `engines.node` is now `>=24`. Node 20 reached end-of-life on 2026-04-30, and AdonisJS 7, which these packages require as a peer, needs Node 24 or later (`@adonisjs/core` declares `engines.node >=24.0.0`). The supported lines are the ones Node still maintains that AdonisJS 7 accepts: 24 and 26, both tested in CI.

## 0.3.7

### Patch Changes

- [`fd14fd6`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/fd14fd608e61c8a35d26d557d0379456c713f7f4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tighten the `exponential()` doc comment to the backoff contract it describes today

## 0.3.6

### Patch Changes

- [#30](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/30) [`ff87963`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/ff87963b2faf4062cde6ce28eb9a13d7525925c3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Widen the optional `@adonisjs/redis` peer to include `^11.0.0` — apps upgrading to redis 11 no
  longer hit a peer conflict. No code change.

## 0.3.5

### Patch Changes

- [#25](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/25) [`1b330b4`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/1b330b4bebb8623696b21da69956b83a61fa26e5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add an optional `maxMs` to `exponential()` so a retry backoff can be capped before jitter is applied (`exponential(baseMs, { maxMs })`). Previously there was no way to bound the delay, so a large `attempts` count could grow into minutes-long waits between retries. `maxMs` is opt-in and off by default — existing callers see no behavior change — since silently imposing a default cap would change an already-deployed delay curve out from under them.

- [#25](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/25) [`1b330b4`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/1b330b4bebb8623696b21da69956b83a61fa26e5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `InMemoryResilienceStore` accepts optional `maxEntries` (LRU eviction) and `ttlMs` (lazy per-key expiry) options, and `stores.memory()` forwards them. Previously the store's internal map only shrank via an explicit `reset(key)`, so an app that composes a circuit `key` from caller-influenced input (e.g. the documented tenant-scoping pattern) had no way to bound its memory growth. Both default to unbounded, matching prior behavior.

- [#25](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/25) [`1b330b4`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/1b330b4bebb8623696b21da69956b83a61fa26e5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `diagnosticsSink()` now sanitizes an event's `error` field down to `{ name, message }` before forwarding it to `@adonis-agora/diagnostics`/Telescope, instead of forwarding the raw caught error as-is. `retry` and `failover` events carry the raw error from the underlying call — which, for an HTTP client wrapping a gateway/LLM response, can carry the response body/headers on a non-standard property (e.g. `err.response.data`) — so forwarding it unsanitized risked leaking secrets/PII into observability storage. Pass an opted-in `sanitizeError` to `diagnosticsSink({ sanitizeError })` for richer detail; `onEvent` callbacks registered directly on a policy still receive the raw, unsanitized error, since those run in-process.

## 0.3.4

### Patch Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/23) [`1c54558`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/1c545589aa08e0ff3a05b95d69059b553b247c09) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept `@adonisjs/redis` 10 and `ioredis` 6 as peers (`^9.2 || ^10`, `^5 || ^6`) for the redis
  store. Nothing narrows; the suite runs against the new majors.

## 0.3.3

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/21) [`0ec7729`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/0ec7729a3930db69f1f0139e8f657b7f3359cc0f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills with the package: three SKILL.md guides (setup & named policies, the `@withResilience` decorator, custom stores + testing) under `skills/`, plus `_artifacts/` domain map, skill spec and skill tree, and a `Check Skills` CI workflow validating them.

## 0.3.2

### Patch Changes

- [#16](https://github.com/DavideCarvalho/adonis-agora-resilience/pull/16) [`ca0ec8f`](https://github.com/DavideCarvalho/adonis-agora-resilience/commit/ca0ec8f278c27a6fed2194e964764280796dd5fd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Restore the `config/resilience.ts` stub, which was empty in the published package.

  The commit that removed backticks from the config stub (they break the stub renderer) removed the entire file contents along with them, so `node ace add @adonis-agora/resilience` and `node ace configure @adonis-agora/resilience` wrote a zero-byte `config/resilience.ts` — no `defineConfig`, no default export — leaving the app with an unusable config file and nothing to adapt. The stub is restored, written without backticks so the original renderer bug stays fixed, and a test now fails if any published `.stub` is empty, missing, or reintroduces a backtick.

## 0.3.1

### Patch Changes

- Export the `configure` hook from the package root so `node ace configure @adonis-agora/resilience` resolves it (ace imports the package root and looks for a `configure` export). Previously it lived only on the `./configure` subpath and ace could not find it.
- Remove markdown backticks from the published config stub comments; the AdonisJS (tempura) stub renderer treats the stub body as a template literal, so a stray backtick broke `node ace configure`.

## 0.3.0

### Minor Changes

- Add `@adonis-agora/resilience/services/main` entrypoint for idiomatic singleton import of the resolved `ResilienceService`.
- Thread the service event sink through `execute()` so `retry` and `timeout` policies emit `agora:resilience:*` diagnostics events (previously only circuit/failover events were emitted).
- Internal refactor: snake_case module filenames; no public API change.

## 0.2.0

### Minor Changes

- [`1af0da5`](https://github.com/DavideCarvalho/adonis-resilience/commit/1af0da5ef7ed4722885c5de6a4d64190c46890ec) - Require AdonisJS v7 (bump @adonisjs/\* peers; Lucid 22)
