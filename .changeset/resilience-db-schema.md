---
"@adonis-agora/resilience": minor
---

`schema` on the Lucid/SQL store (`stores.lucid({ connection: 'pg', schema: 'resilience' })`): the circuit, bulkhead and rate-limiter tables live in their own Postgres schema, created on first use with `CREATE SCHEMA IF NOT EXISTS`. Every statement names the schema, so nothing depends on `search_path` and it is safe behind PgBouncer in transaction mode; it works on any connection, including the app's transaction. `resilienceDdl({ schema })`, `circuitsDdl`/`bulkheadsDdl`/`rateLimitsDdl` and `ensureResilienceSchema(db, { schema })` build the DDL for it. SQLite with `schema` fails at boot. `agora:doctor --deep` reports whether the schema exists, holds the tables and is writable.
