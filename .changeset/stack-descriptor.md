---
"@adonis-agora/resilience": patch
---

The Lucid and Redis circuit stores describe what they run on (`breaker state` on their connection, the app's default one when unset) under `Symbol.for('@adonis-agora/stack')`, so telescope's Architecture page shows them with no extra code.
