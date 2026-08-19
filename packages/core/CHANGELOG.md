# @adonis-agora/resilience

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
