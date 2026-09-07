---
'@adonis-agora/resilience': patch
---

`diagnosticsSink()` now sanitizes an event's `error` field down to `{ name, message }` before forwarding it to `@adonis-agora/diagnostics`/Telescope, instead of forwarding the raw caught error as-is. `retry` and `failover` events carry the raw error from the underlying call — which, for an HTTP client wrapping a gateway/LLM response, can carry the response body/headers on a non-standard property (e.g. `err.response.data`) — so forwarding it unsanitized risked leaking secrets/PII into observability storage. Pass an opted-in `sanitizeError` to `diagnosticsSink({ sanitizeError })` for richer detail; `onEvent` callbacks registered directly on a policy still receive the raw, unsanitized error, since those run in-process.
