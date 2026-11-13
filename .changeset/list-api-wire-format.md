---
"@adonis-agora/resilience": major
---

The service's lists answer the `@adonis-agora/filter` list format, `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`.

- `recentEvents({ type?, key?, policy?, first?, after?, last?, before? })` is a cursor feed: page to older events with `after = meta.nextCursor`, to newer ones with `before = meta.prevCursor`. A cursor it did not produce throws `InvalidCursorError` (exported).
- `circuits()`, `bulkheads()` and `rateLimiters()` take `first` (default 100, at most 1000) and return one page; `meta.hasNext` says more match.
- `limit` is gone from all four.
- The Telescope `resilience.circuits` table answers the offset page `{ data, meta }`; the `resilience.transitions` provider reads `first`.
