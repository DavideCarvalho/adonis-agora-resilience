---
name: resilience-setup-policies
description: >-
  Set up @adonis-agora/resilience in an AdonisJS 7 app and run operations through
  resilience policies. Covers node ace configure, config/resilience.ts with
  defineConfig/stores.memory()/named policies, the ResilienceService singleton
  from @adonis-agora/resilience/services/main (execute by name or ad-hoc,
  failover, circuit(key).snapshot()/reset(), circuitStore(name?)), composing
  wrap(timeout(...), retry(...), exponential(...), circuitBreaker(...)) standalone,
  threading PolicyContext.signal into fetch so timeouts cancel work, TimeoutError
  vs BrokenCircuitError handling, and diagnostics event emission via
  agora:resilience:* / diagnosticsSink(). Use when installing the package,
  registering named policies, wrapping a flaky outbound call, wiring failover
  across providers, or debugging why circuit events never fire.
metadata:
  type: core
  library: '@adonis-agora/resilience'
  library_version: '0.3.2'
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-resilience:README.md'
  - 'DavideCarvalho/adonis-resilience:docs/getting-started.mdx'
  - 'DavideCarvalho/adonis-resilience:docs/policies.mdx'
  - 'DavideCarvalho/adonis-resilience:docs/integrations.mdx'
  - 'DavideCarvalho/adonis-resilience:packages/core/src/resilience_service.ts'
---

# Setup, config and the ResilienceService

`@adonis-agora/resilience` gives AdonisJS 7 apps timeout, retry, circuit breaker
and ordered failover. Policies compose as plain functions — no AdonisJS required —
or register once in `config/resilience.ts` and get called through the
container-resolved `ResilienceService`. Every policy exposes `execute(op)`; the
operation receives a `PolicyContext` of `{ signal, attempt }`.

## Setup

Install and let the AdonisJS configure step register the provider and publish
the config file:

```sh
node ace add @adonis-agora/resilience
# already installed? re-run just the configure step:
node ace configure @adonis-agora/resilience
```

This registers `@adonis-agora/resilience/resilience_provider` in `adonisrc.ts`
and writes `config/resilience.ts`:

```ts
// config/resilience.ts
import { defineConfig, stores, wrap, timeout, retry, exponential } from '@adonis-agora/resilience'

export default defineConfig({
  // The circuit-breaker store. `memory` is in-process; see Stores for Lucid/Redis.
  default: 'memory',
  stores: {
    memory: stores.memory(),
  },

  // Emit diagnostics events on `agora:resilience:*`. Default true.
  emit: true,

  // Named, reusable policies resolvable via `resilience.execute('payments', op)`.
  policies: {
    payments: () => wrap(timeout(2_000), retry({ attempts: 3, backoff: exponential(100) })),
  },
})
```

The provider binds a singleton `ResilienceService` built lazily from this config.
Import the ready-made singleton — not a hand-constructed instance — from
`@adonis-agora/resilience/services/main`:

```ts
// app/services/payment_gateway_service.ts
import resilience from '@adonis-agora/resilience/services/main'

export default class PaymentGatewayService {
  async charge(orderId: number) {
    return resilience.execute('payments', ({ signal }) =>
      fetch('https://api.stripe.com/v1/charges', {
        method: 'POST',
        body: JSON.stringify({ orderId }),
        signal, // thread the abort signal so the 2s timeout can cancel the request
      }).then((res) => res.json()),
    )
  }
}
```

Source: `docs/getting-started.mdx`, `packages/core/src/services/main.ts`,
`packages/core/src/define_config.ts`.

## Core patterns

### Pattern 1 — compose policies standalone with `wrap`, outermost first

No AdonisJS app needed; the engine is plain TypeScript.

```ts
import {
  wrap,
  timeout,
  retry,
  exponential,
  circuitBreaker,
  InMemoryResilienceStore,
} from '@adonis-agora/resilience'

const store = new InMemoryResilienceStore()

const charge = wrap(
  timeout(2_000), // outermost — bounds the ENTIRE retry loop
  retry({ attempts: 3, backoff: exponential(100) }), // 3 total tries, 100ms → 200ms
  circuitBreaker({ key: 'payments', store, threshold: 5, cooldownMs: 30_000 }), // innermost
)

const result = await charge.execute(() => chargeCard(order))
```

Read it top-down: execution order is `timeout(retry(breaker(op)))`. Put
`timeout` inside `retry` instead (`wrap(retry({ attempts: 3 }), timeout(1_000))`)
when each attempt should get its own deadline. Source:
`docs/policies.mdx § wrap` and its per-attempt-timeout recipe.

### Pattern 2 — failover across ordered targets through the service

`failover()` is a function, not a `Policy`; calling the exported one directly
emits nowhere. Through `ResilienceService.failover` the service's event sink is
wired for you, and per-target breakers skip known-dead targets instantly:

```ts
import resilience from '@adonis-agora/resilience/services/main'
import { wrap, timeout, circuitBreaker } from '@adonis-agora/resilience'

const store = resilience.circuitStore()

const sms = await resilience.failover({
  targets: [twilio, vonage, sns],
  run: (provider, { signal }) => provider.send(message, { signal }),
  policy: (provider) =>
    wrap(circuitBreaker({ key: `sms:${provider.id}`, store, threshold: 5, cooldownMs: 30_000 }), timeout(8_000)),
  onFailover: (provider, err, i) => logger.warn(`sms #${i} ${provider.id} failed: ${err}`),
})
```

Source: `docs/policies.mdx § failover`, `docs/integrations.mdx`.

### Pattern 3 — inspect and reset circuits

`circuit(key)` works on the default store; `circuitStore(name?)` reaches any
store listed under `config.stores` to hand to an explicit `circuitBreaker`.

```ts
import resilience from '@adonis-agora/resilience/services/main'

const snap = await resilience.circuit('payments').snapshot()
// { status: 'closed' | 'open' | 'half-open', failures: number, openUntil?: number }

await resilience.circuit('payments').reset() // force back to closed, failures = 0

const redis = resilience.circuitStore('redis') // throws if 'redis' is not in config.stores
```

Source: `packages/core/src/resilience_service.ts` (`circuit`, `circuitStore`),
`docs/testing.mdx § Asserting circuit state`.

### Pattern 4 — mirror circuit events onto your own emitter

Every transition is a `ResilienceEvent`; the service republishes to
`@adonis-agora/diagnostics` as `agora:resilience:<type>` and can also mirror to
any EventEmitter-like object (event names via `resilienceEventName(type)`:
`circuit-opened` → `resilience.circuit.opened`).

```ts
// config/resilience.ts
import { defineConfig } from '@adonis-agora/resilience'
import type { EventEmitterLike } from '@adonis-agora/resilience'
import emitter from '@adonisjs/core/services/emitter'

export default defineConfig({ eventEmitter: emitter as unknown as EventEmitterLike })
```

```ts
emitter.on('resilience.circuit.opened', (event) => notifyOncall(event.key))
```

Source: `docs/integrations.mdx § EventEmitter mirror`,
`packages/core/src/integration/event_emitter.ts`.

## Common mistakes

### HIGH Reading `wrap` arguments right-to-left

Wrong:

```ts
// intended: 2s budget for the whole loop, breaker per attempt
const policy = wrap(
  circuitBreaker({ key: 'payments', store, threshold: 5, cooldownMs: 30_000 }),
  timeout(2_000), // actually innermost → per-retry deadline, breaker outside the retries
  retry({ attempts: 3 }),
)
```

Correct:

```ts
// first argument = outermost layer: timeout(retry(breaker(op)))
const policy = wrap(
  timeout(2_000),
  retry({ attempts: 3 }),
  circuitBreaker({ key: 'payments', store, threshold: 5, cooldownMs: 30_000 }),
)
```

Mechanism: the first `wrap` argument is the outermost layer and the last sits
closest to the operation; reversed, one failing dependency trips the breaker
before any retry runs and the deadline bounds each try instead of the loop.

Source: `docs/policies.mdx § "wrap — compose policies"`

### CRITICAL Ignoring `PolicyContext.signal` so timeouts cannot cancel anything

Wrong:

```ts
await resilience.execute('payments', () =>
  fetch(url, { method: 'POST' }).then((r) => r.json()),
) // rejects with TimeoutError at 2s, but the request keeps running
```

Correct:

```ts
await resilience.execute('payments', ({ signal }) =>
  fetch(url, { method: 'POST', signal }).then((r) => r.json()),
)
```

Mechanism: a timeout can only cancel work that listens to the `AbortSignal`;
without threading `ctx.signal` into the HTTP client/DB driver the promise rejects
while the underlying request runs to completion, holding connections under load.

Source: `docs/policies.mdx § timeout (Callout)`, `docs/getting-started.mdx`

### MEDIUM Treating `retry.attempts` as retries after the first try

Wrong:

```ts
// meant "1 try + 4 retries" → actually up to 5 executions against a rate-limited API
retry({ attempts: 5, backoff: exponential(100) })
```

Correct:

```ts
// three TOTAL tries, waiting 100ms then 200ms between them
retry({ attempts: 3, backoff: exponential(100) })
```

Mechanism: `attempts` counts total tries — after the last failure the final error
is rethrown — so off-by-one assumptions overshoot upstream latency budgets and
rate limits silently.

Source: `docs/policies.mdx § "retry and backoff"` ("attempts: 3 means three total tries")

### HIGH Expecting diagnostics events from hand-built policies passed to `execute()`

Wrong:

```ts
const policy = wrap(timeout(2_000), retry({ attempts: 3 })) // built at module scope
await resilience.execute(policy, op) // silent: no agora:resilience:* events, ever
```

Correct:

```ts
// config/resilience.ts — built inside the named factory window, gets the service's sink
policies: { payments: () => wrap(timeout(2_000), retry({ attempts: 3 })) }
await resilience.execute('payments', op)

// ...or pass the sink explicitly at build time:
await resilience.execute(timeout(1_000, { onEvent: diagnosticsSink() }), op)
```

Mechanism: a policy captures its sink **when it is built**, not when it runs;
only factories registered under `policies` are invoked inside the service's
sink-injecting window, so a module-level `Policy` stays invisible to diagnostics
and the emitter mirror no matter how it is executed.

Source: `docs/integrations.mdx § "Which policies get the service's sink"`

### MEDIUM Calling `circuitStore(name)` for a store that is not in `config.stores`

Wrong:

```ts
// config lists only memory, but this code assumes redis exists:
const store = resilience.circuitStore('redis') // throws at runtime
circuitBreaker({ key: 'cart', store, threshold: 5, cooldownMs: 30_000 })
```

Correct:

```ts
// 1. list it: stores: { memory: stores.memory(), redis: stores.redis({ connection: 'main' }) }
// 2. then resolve it by name:
const store = resilience.circuitStore('redis')
circuitBreaker({ key: 'cart', store, threshold: 5, cooldownMs: 30_000 })
```

Mechanism: only stores registered in the config's `stores` map are resolvable by
name; `requireStore` throws `Unknown resilience store "<name>".` otherwise — the
same failure a named policy factory hits when it resolves a store nobody listed.

Source: `packages/core/src/resilience_service.ts` (`requireStore`),
`docs/custom-store.mdx § "Reaching it from code"`

See also: `resilience-decorator/SKILL.md` — the declarative counterpart of
Pattern 1, and the escape hatch when a timeout must cancel the transport.
See also: `resilience-custom-stores-testing/SKILL.md` — choosing and registering
the store behind `default`/`circuitStore(name?)`, and testing all of it.
