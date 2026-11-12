---
"@adonis-agora/resilience": patch
---

The Lucid/SQL store works on MySQL 8 and MariaDB, as the docs said. Before, its first statement failed there (`key TEXT PRIMARY KEY`, the reserved word `key` unquoted, `ON CONFLICT`) and rows from `mysql2` were misread. On MySQL the key columns are `VARCHAR(512)` with the `utf8mb4_bin` collation (`MYSQL_KEY_LENGTH`; keys compare exactly, as on Postgres), `key` is quoted, and existing rows are skipped with `ON DUPLICATE KEY UPDATE`. `SqlDriver` takes `dialect: 'mysql'` and the DDL helpers take `{ dialect: 'mysql' }`. Postgres and SQLite SQL is unchanged.
