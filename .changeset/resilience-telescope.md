---
"@adonis-agora/resilience": minor
---

A "Resilience" page in `@adonis-agora/telescope`, added automatically when telescope is installed (through the `agora.telescope.extensions` container value): open and half-open circuits, short-circuits, retries, timeouts, error rate, bulkhead rejections and rate-limited calls of the last hour, the circuits / bulkheads / rate-limiters tables, events over time, the noisiest policies and recent transitions. Open circuits have a Reset button (confirmation, telescope console `authorize`, audit line and `circuit-reset` event with the acting user). `@adonis-agora/resilience/telescope` exports `resilienceTelescopeExtension()` for manual wiring; `telescope: false` or `telescope: { reset: false }` in `config/resilience.ts` opt out.
