---
"@adonis-agora/resilience": major
---

1.0.0: the API is now stable.

Breaking changes:

- Node.js 24 or newer is required (`"engines": { "node": ">=24" }`).
- `SqlDriver.run` is required. A custom driver for `SqlResilienceStore` must implement it (a plain write outside a transaction); the fallback that ran the statement in its own transaction is gone.
- `stores.redis()` and `stores.lucid()` resolve their connection from the `redis` / `lucid.db` container bindings only. The fallback to `@adonisjs/redis/services/main` / `@adonisjs/lucid/services/db` is removed: register `@adonisjs/redis/redis_provider` or `@adonisjs/lucid/database_provider` before the resilience provider.

See [Migrating to 1.0](https://davidecarvalho.github.io/agora/docs/resilience/migrating-to-1.0).
