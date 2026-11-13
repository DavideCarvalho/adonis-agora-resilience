---
"@adonis-agora/resilience": minor
---

CLI parity with the Telescope page and the MCP tools. New commands: `resilience:policies:list`, `resilience:circuits:show`, `resilience:bulkheads:list`, `resilience:bulkheads:show`, `resilience:rate-limiters:list`, `resilience:rate-limiters:show`. Every list takes `--store`, `--prefix`, `--first` and `--json` (`{ data, meta }`); every show takes `--store` and `--json`.

**Breaking (rc):** `resilience:circuits` is now `resilience:circuits:list` and `resilience:reset` is now `resilience:circuits:reset`, with no alias. The reset asks for confirmation unless `--force` (and refuses without a terminal), and records the actor as `cli:<os user>` instead of `cli`.
