---
'@adonis-agora/resilience': patch
---

Add an optional `maxMs` to `exponential()` so a retry backoff can be capped before jitter is applied (`exponential(baseMs, { maxMs })`). Previously there was no way to bound the delay, so a large `attempts` count could grow into minutes-long waits between retries. `maxMs` is opt-in and off by default — existing callers see no behavior change — since silently imposing a default cap would change an already-deployed delay curve out from under them.
