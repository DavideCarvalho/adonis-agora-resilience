---
"@adonis-agora/resilience": minor
---

`node ace agora:doctor` and `node ace resilience:doctor`: health checks for the resilience configuration (`resilience.store`, `resilience.policies`, `resilience.limits-scope`, and with `--deep` `resilience.store-reachable`), plus peer-range and release-train checks, registered in the shared `agora.doctor` registry so one `agora:doctor` run covers every installed `@adonis-agora` lib. Flags: `--lib`, `--only`, `--deep`, `--json`, `--strict`, `--verbose`, `--no-boot`; exit code 0 / 1 / 2.
