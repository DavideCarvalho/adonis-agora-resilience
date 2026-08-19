---
'@adonis-agora/resilience': patch
---

Restore the `config/resilience.ts` stub, which was empty in the published package.

The commit that removed backticks from the config stub (they break the stub renderer) removed the entire file contents along with them, so `node ace add @adonis-agora/resilience` and `node ace configure @adonis-agora/resilience` wrote a zero-byte `config/resilience.ts` — no `defineConfig`, no default export — leaving the app with an unusable config file and nothing to adapt. The stub is restored, written without backticks so the original renderer bug stays fixed, and a test now fails if any published `.stub` is empty, missing, or reintroduces a backtick.
