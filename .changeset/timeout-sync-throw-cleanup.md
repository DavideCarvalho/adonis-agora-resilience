---
"@adonis-agora/resilience": patch
---

fix(timeout): when the wrapped op throws synchronously, disarm the timeout timer and detach the parent-signal abort listener before rethrowing. Previously the timer stayed armed (emitting a spurious `timeout` event later) and the listener leaked onto the parent signal, accumulating on long-lived signals.
