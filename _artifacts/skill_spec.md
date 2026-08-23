# Skill spec — @adonis-agora/resilience

Autonomous compressed discovery (minimal-library fast path). No maintainer
interview was run (fully-autonomous constraint); everything below is grounded in
README.md, DESIGN.md, docs/*.mdx, packages/core/src/**, and
packages/core/package.json. Unconfirmed questions are recorded in Remaining Gaps.

`@adonis-agora/resilience` gives AdonisJS 7 apps resilience policies — timeout,
retry with backoff, circuit breaker, and ordered failover. Policies compose as
plain functions with `wrap(...)`, or run as named policies registered in
`config/resilience.ts` and reached through the container-resolved
`ResilienceService`. Circuit-breaker state sits behind a four-method
`ResilienceStore` contract with in-memory, Lucid/SQL, and Redis drivers shipping
in the single `packages/core` package; ecosystem integration
(`@adonis-agora/diagnostics`, `@adonis-agora/context`) is soft-detected through
global `Symbol.for(...)` slots, so nothing is a hard dependency.

## Scope decision

Single-package library (`@adonis-agora/resilience@0.3.2`, `packages/core`). The
minimal-library fast path applies: flat structure, no router skill, no core
overview, every skill type `core`, all owned by the one package.

## Domains

| Domain | Description | Skills |
| ------ | ----------- | ------ |
| Composing and running policies | The policy engine: wrap order, timeout/signal, retry/backoff, breaker state machine, failover, typed errors | resilience-setup-policies |
| Wiring resilience into an AdonisJS app | configure + config file, service singleton, decorator, event sinks | resilience-setup-policies, resilience-decorator |
| Owning circuit state | ResilienceStore contract, three built-in stores, custom engines, contract suite | resilience-custom-stores-testing |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| ----- | ---- | ------ | -------------- | ------------- |
| resilience-setup-policies | core | policies + app-wiring | install/configure, standalone wrap composition, config/resilience.ts named policies, ResilienceService singleton (execute/failover/circuit/circuitStore), TimeoutError/BrokenCircuitError | 5 |
| resilience-decorator | core | app-wiring | @withResilience on async methods, composition order, explicit store at class-definition time, when to use execute instead | 3 |
| resilience-custom-stores-testing | core | stores | stores.memory/lucid/redis, boot-builds-every-listed-store, CIRCUITS_DDL migrations, custom store tiers (SqlDriver / computeAdmit+computeRecord / from scratch), StoreProvider, circuitStore(name?), runResilienceStoreContract, FakeClock | 5 |

## Failure Mode Inventory

### resilience-setup-policies (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Reading wrap arguments right-to-left | HIGH | docs/policies.mdx § wrap | resilience-decorator |
| 2 | Ignoring PolicyContext.signal so timeouts cannot cancel | CRITICAL | docs/policies.mdx timeout Callout; docs/getting-started.mdx | resilience-decorator |
| 3 | Treating retry.attempts as re-attempts after the first try | MEDIUM | docs/policies.mdx § retry ("three total tries") | — |
| 4 | Expecting events from hand-built policies passed to execute() | HIGH | docs/integrations.mdx § Which policies get the service's sink | — |
| 5 | Calling circuitStore(name) for an unregistered store name | MEDIUM | packages/core/src/resilience_service.ts; docs/custom-store.mdx | — |

### resilience-decorator (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Decorating a non-async method with withResilience | MEDIUM | docs/decorator.mdx § The method shape | — |
| 2 | Assuming a decorator timeout cancels the underlying request | CRITICAL | docs/decorator.mdx Callout | resilience-custom-stores-testing |
| 3 | Omitting the required store on a decorated circuitBreaker | HIGH | docs/decorator.mdx § Providing a store; packages/core/src/policies/circuit_breaker.ts | — |

### resilience-custom-stores-testing (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Listing stores whose peer dependencies are not installed | CRITICAL | docs/stores.mdx boot Callout; docs/custom-store.mdx warning | resilience-setup-policies |
| 2 | Building dashboards or health checks on raw snapshot() output | MEDIUM | docs/stores.mdx snapshot Callout | — |
| 3 | Writing a store whose admit and record are not atomic | HIGH | docs/custom-store.mdx hard rule; docs/stores.mdx atomicity Callout | — |
| 4 | Skipping runResilienceStoreContract for a Tier-3 store | HIGH | docs/custom-store.mdx source-of-truth twin warning | — |
| 5 | Using real timers when testing cooldowns and backoff | MEDIUM | docs/testing.mdx § The clock seam | — |

## Tensions

| Tension | Skills | Agent implication |
| ------- | ------ | ----------------- |
| Decorator ergonomics vs genuine cancellation | resilience-decorator ↔ resilience-setup-policies | Agents decorate methods with timeout(...) and assume the deadline aborts the HTTP call |
| Observability defaults vs standalone-policy silence | resilience-setup-policies ↔ resilience-decorator | Agents set emit:true and a module-level wrap, then conclude telemetry is broken |

## Cross-References

| From | To | Reason |
| ---- | -- | ------ |
| resilience-setup-policies | resilience-custom-stores-testing | Named breakers and circuitStore(name?) only resolve stores config lists |
| resilience-decorator | resilience-custom-stores-testing | Decorated breakers need an explicit module-scope store |
| resilience-decorator | resilience-setup-policies | Argument order mirrors wrap; execute is the cancellation escape hatch |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| ----- | ---------- | -------------------- |
| resilience-setup-policies | — | — |
| resilience-decorator | — | — |
| resilience-custom-stores-testing | memory / lucid / redis built-ins (distinct config surfaces, but small enough to stay inline) | — |

The three stores each have distinct config interfaces but each surface fits in
one short block; per the minimal-library fast path they stay inline rather than
spawning references/ files.

## Remaining Gaps

| Skill | Question | Status |
| ----- | -------- | ------ |
| resilience-setup-policies | Is the silent-sink rule the most-reported confusion in issues/Discord? | open |
| resilience-decorator | How often does the non-cancelling decorator timeout bite in production? | open |
| resilience-custom-stores-testing | Are Prisma/TypeORM/MikroORM/drizzle drivers imminent enough to document now? | open |

No GitHub issue mining was performed this session (autonomous constraint), so
real-world failure frequencies are inferred from doc callout emphasis and source
comments rather than issue telemetry.

## Recommended Skill File Structure

- **Core skills:** all three skills are framework-facing AdonisJS patterns over a
  framework-agnostic engine; all are type `core` per the fast path.
- **Framework skills:** none — there are no separate adapter packages.
- **Lifecycle skills:** none — getting-started material is folded into
  resilience-setup-policies.
- **Composition skills:** none as standalone files — diagnostics/context/Telescope
  integration is soft-detected and summarized inside resilience-setup-policies.
- **Reference files:** none needed — every skill stays well under 500 lines.

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| ------- | ------------------ | ------------------------- |
| @adonis-agora/diagnostics | diagnosticsSink(), agora:resilience:* events, Telescope watchers | no — covered inline in resilience-setup-policies |
| @adonis-agora/context | tenantSuffix() for per-tenant breaker keys | no — one pattern, covered inline |
| @adonisjs/lucid / @adonisjs/redis / ioredis | optional peers behind stores.lucid()/stores.redis() | no — covered inline in resilience-custom-stores-testing |
