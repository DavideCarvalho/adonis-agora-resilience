# @adonis-agora/resilience

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
