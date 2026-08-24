---
name: resilience-decorator
description: >-
  Apply resilience policies to async class methods declaratively with the
  @withResilience method decorator from @adonis-agora/resilience — argument order
  mirrors wrap (outermost first), this/arguments/return type are preserved, only
  async methods can be decorated, circuitBreaker needs an explicit store because
  decorators run at class-definition time (InMemoryResilienceStore,
  lucidResilienceStore(db), or resilience.circuitStore()), and a decorator timeout
  rejects with TimeoutError but cannot abort the transport — prefer
  ResilienceService.execute when ctx.signal must reach fetch. Use when attaching
  fixed retry/circuit-breaker policies to a client method instead of wrapping
  every call site.
metadata:
  type: core
  library: '@adonis-agora/resilience'
  library_version: '0.3.2'
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-resilience:docs/decorator.mdx'
  - 'DavideCarvalho/adonis-resilience:docs/policies.mdx'
  - 'DavideCarvalho/adonis-resilience:packages/core/src/decorator.ts'
---

# Declarative usage — `@withResilience`

`@withResilience(...policies)` is a TypeScript method decorator that runs the
decorated method through a composed pipeline. It is the declarative counterpart
of `service.execute(wrap(...policies))` — same policies, same engine, less
boilerplate.

## Setup

```ts
import {
  withResilience,
  timeout,
  retry,
  circuitBreaker,
  InMemoryResilienceStore,
} from '@adonis-agora/resilience'

const store = new InMemoryResilienceStore()

class PaymentClient {
  @withResilience(
    timeout(1_000),                                // outermost
    retry({ attempts: 3 }),                        // retries the timed-out call
    circuitBreaker({ key: 'pay', store, threshold: 5, cooldownMs: 30_000 }), // innermost
  )
  async charge(amount: number): Promise<Receipt> {
    return this.http.post('/charge', { amount })
  }
}
```

Calling `charge()` executes `timeout(retry(circuitBreaker(body)))`, exactly as
`wrap(timeout(1_000), retry({ attempts: 3 }), circuitBreaker({ … }))` would.

Source: `docs/decorator.mdx`.

## Core patterns

### Pattern 1 — per-attempt deadline by reordering

Argument order mirrors `wrap`: first policy = outermost, last = closest to the
method body. Swap the first two to bound each try instead of the whole loop:

```ts
import { withResilience, retry, timeout } from '@adonis-agora/resilience'

class SearchClient {
  // retry(timeout(search)) — each attempt gets its own 1s budget
  @withResilience(retry({ attempts: 3 }), timeout(1_000))
  async search(q: string): Promise<Results> {
    return this.http.get('/search', { params: { q } })
  }
}
```

Source: `docs/decorator.mdx § "Composition order"`.

### Pattern 2 — `this` and arguments are intact

The decorator preserves `this`, all arguments, and the return type, so decorated
methods behave like plain ones apart from the pipeline:

```ts
import { withResilience, retry } from '@adonis-agora/resilience'

class Greeter {
  greeting = 'hello'

  @withResilience(retry({ attempts: 2 }))
  async greet(name: string): Promise<string> {
    return `${this.greeting} ${name}` // `this` and args are intact
  }
}
```

Only **async** methods can be decorated — the policies are promise-based.

Source: `docs/decorator.mdx § "The method shape"`.

### Pattern 3 — give the breaker a real store at module scope

A decorator runs at class-definition time, so there is no per-request container
to resolve a store from: pass an explicit one. Reuse the app's configured store
via the service singleton so config stays the single source of truth:

```ts
import resilience from '@adonis-agora/resilience/services/main'
import { withResilience, circuitBreaker } from '@adonis-agora/resilience'

// default store from config/resilience.ts; resilience.circuitStore('redis') for a named one
const store = resilience.circuitStore()

class InventoryClient {
  @withResilience(circuitBreaker({ key: 'inventory', store, threshold: 5, cooldownMs: 30_000 }))
  async check(sku: string): Promise<Stock> {
    return this.db.find(sku)
  }
}
```

For SQL-backed state outside config use `lucidResilienceStore(db)` /
`redisResilienceStore(client)` directly (see
`resilience-custom-stores-testing/SKILL.md`). Share one instance across every
breaker that should trip together.

Source: `docs/decorator.mdx § "Providing a store"`,
`packages/core/src/policies/circuit_breaker.ts`.

## Common mistakes

### CRITICAL Assuming a decorator timeout cancels the underlying request

Wrong:

```ts
class PaymentClient {
  @withResilience(timeout(1_000), retry({ attempts: 3 }))
  async charge(amount: number) {
    return this.http.post('/charge', { amount }) // no signal → request never aborted
  }
}
```

Correct:

```ts
class PaymentClient {
  // the operation receives ctx, so `signal` reaches fetch and the request is aborted
  charge(amount: number) {
    return resilience.execute(policy, ({ signal }) =>
      this.http.post('/charge', { amount }, { signal }),
    )
  }
}
```

Mechanism: the decorator calls your method with its original arguments and has
nowhere to hand over the `PolicyContext`, so `ctx.signal` never reaches the body;
at the deadline `charge()` rejects with `TimeoutError` but the HTTP call runs to
completion in the background, accumulating abandoned in-flight work under load.
Use the decorator for *retry/fail-fast* semantics and `execute` when a deadline
must reach the transport.

Source: `docs/decorator.mdx Callout "A timeout here rejects, but does not cancel"`

### MEDIUM Decorating a non-async method

Wrong:

```ts
class InventoryClient {
  @withResilience(retry({ attempts: 3 }))
  check(sku: string): Stock { // sync method — cannot be wrapped in a promise pipeline
    return this.db.find(sku)
  }
}
```

Correct:

```ts
class InventoryClient {
  @withResilience(retry({ attempts: 3 }))
  async check(sku: string): Promise<Stock> {
    return this.db.find(sku)
  }
}
```

Mechanism: policies are promise-based, so only methods returning a `Promise` can
be decorated; a sync method silently sits outside the contract the decorator is
built on.

Source: `docs/decorator.mdx § "The method shape"`

### HIGH Omitting `store` on a decorated `circuitBreaker`

Wrong:

```ts
@withResilience(circuitBreaker({ key: 'pay', threshold: 5, cooldownMs: 30_000 }))
async pay() {} // no store — nothing defines where breaker state lives
```

Correct:

```ts
import resilience from '@adonis-agora/resilience/services/main'
import { withResilience, circuitBreaker } from '@adonis-agora/resilience'

const store = resilience.circuitStore()

class PaymentClient {
  @withResilience(circuitBreaker({ key: 'pay', store, threshold: 5, cooldownMs: 30_000 }))
  async pay() {}
}
```

Mechanism: the breaker has no implicit module-wide store — `store` is a required
option of `circuitBreaker`, and a class-definition-time decorator has no
container to resolve one from; omitting it breaks the pipeline instead of
falling back to anything.

Source: `docs/decorator.mdx § "Providing a store"`,
`packages/core/src/policies/circuit_breaker.ts` (`store: ResilienceStore` required)

### HIGH Tension: decorator ergonomics vs observability

Policies attached with `@withResilience` are built at class-definition time,
outside any named-policy factory — so like every hand-built policy they capture
no event sink and emit nothing to `agora:resilience:*`, even with `emit: true`
in config. Pass an explicit `onEvent` to the policies you decorate if their
transitions must be observable.

See also: `docs/integrations.mdx § "Which policies get the service's sink"`.

See also: `resilience-setup-policies/SKILL.md` — `wrap` composition semantics and
the `execute(({ signal }) => ...)` escape hatch.
See also: `resilience-custom-stores-testing/SKILL.md` — building the explicit
store a decorated breaker requires.
