---
"@adonis-agora/resilience": patch
---

`stores.redis()` and `stores.lucid()` resolve their connection from the container (`'redis'` / `'lucid.db'`) instead of the `services/main` / `services/db` modules. Those modules only export the service after `app.booted()`, so a `ResilienceService` resolved during boot (injected into a class the app instantiates while booting, such as a discovered `@adonis-agora/durable` step) failed with "Cannot read properties of undefined (reading 'connection')". The service modules remain the fallback when the binding is missing, and a missing peer provider now gets an error that names it.
