# @adonis-agora/resilience

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
