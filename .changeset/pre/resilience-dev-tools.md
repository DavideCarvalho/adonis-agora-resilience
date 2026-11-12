---
"@adonis-agora/resilience": minor
---

Developer tools and commands:

- With `@adonis-agora/agent`'s MCP provider installed, resilience registers its tools on the dev MCP endpoint (`/mcp/agora`), gated by the endpoint's `devTools.authorize`: `resilience_list_policies`, `resilience_list_circuits`, `resilience_get_circuit`, `resilience_list_bulkheads`, `resilience_list_rate_limiters`, `resilience_list_recent_events` and the action `resilience_reset_circuit` (audited with the caller). `devTools: false` in `config/resilience.ts` leaves them out.
- New ace commands `resilience:circuits` (`--status`, `--store`, `--json`) and `resilience:reset <key>` (`--store`), exported as `@adonis-agora/resilience/commands` and registered by `configure`. Existing apps add `() => import('@adonis-agora/resilience/commands')` to `commands` in `adonisrc.ts`.
