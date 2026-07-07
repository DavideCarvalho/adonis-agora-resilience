# `@adonis-agora/resilience`

> Resilience policies for **AdonisJS** — timeout, retry, circuit breaker, and
> ordered failover — with pluggable circuit stores. Part of the
> [Agora](https://github.com/DavideCarvalho) ecosystem.

## Install

```sh
npm i @adonis-agora/resilience
node ace configure @adonis-agora/resilience
```

## Use

Compose policies as plain functions, or register named ones in `config/resilience.ts`:

```ts
import { wrap, timeout, retry, exponential, circuitBreaker } from '@adonis-agora/resilience'

const policy = wrap(
  timeout(2000),
  retry({ attempts: 3, backoff: exponential(100) }),
  circuitBreaker({ key: 'payments', threshold: 5, cooldownMs: 30_000 }),
)
const result = await policy.execute(() => chargeCard())
```

Or register named policies in `config/resilience.ts` and reach them through the
singleton service — inject it into a service that wraps an outbound call:

```ts
// app/services/payment_gateway_service.ts
import resilience from '@adonis-agora/resilience/services/main'
import type Order from '#models/order'

export default class PaymentGatewayService {
  charge(order: Order) {
    // the named `payments` policy wraps the call to the gateway
    return resilience.execute('payments', ({ signal }) =>
      fetch('https://api.stripe.com/v1/charges', {
        method: 'POST',
        body: JSON.stringify({ amount: order.total }),
        signal,
      }).then((res) => res.json()),
    )
  }
}
```

A controller injects that service, and an open circuit becomes a real `503`:

```ts
// app/controllers/payments_controller.ts
import { inject } from '@adonisjs/core'
import { HttpContext } from '@adonisjs/core/http'
import { BrokenCircuitError } from '@adonis-agora/resilience'
import PaymentGatewayService from '#services/payment_gateway_service'

@inject()
export default class PaymentsController {
  constructor(private payments: PaymentGatewayService) {}

  async store({ request, response }: HttpContext) {
    try {
      return response.ok(await this.payments.charge(request.body()))
    } catch (error) {
      if (error instanceof BrokenCircuitError) {
        return response.serviceUnavailable({ message: 'Payments are temporarily unavailable' })
      }
      throw error
    }
  }
}
```

The same singleton also runs an ordered `failover({ targets, run })` and inspects
a circuit via `resilience.circuit('payments').snapshot()`.

Events publish on `agora:resilience:*` via `@adonis-agora/diagnostics` when installed
(read structurally through a global slot — no hard dependency), so a Telescope
watcher records every circuit open / failover / retry with `traceId` correlation.
Per-tenant circuit keys read the tenant from `@adonis-agora/context` when present.

## Circuit stores

The circuit store is selected in `config/resilience.ts` with the `stores` factory.
All three ship in this package; the Lucid/Redis drivers lazily import their peer
dependency only when selected, so installing one stays optional.

```ts
import { defineConfig, stores } from '@adonis-agora/resilience'

export default defineConfig({
  default: 'memory',
  stores: {
    memory: stores.memory(),                      // in-process (default)
    lucid: stores.lucid({ connection: 'pg' }),    // SQL via @adonisjs/lucid
    redis: stores.redis({ connection: 'main' }),  // @adonisjs/redis + ioredis
  },
})
```

- **memory** (default): in-process, single process — no peer dependency.
- **lucid**: SQL via `@adonisjs/lucid` (Postgres / MySQL / SQLite); table
  auto-created, or run `CIRCUITS_DDL` from a migration.
- **redis**: distributed via `@adonisjs/redis` / `ioredis`; atomic Lua, no schema.

Bring your own engine by implementing `SqlDriver` over the exported
`SqlResilienceStore`, or the four `ResilienceStore` methods directly.

## License

MIT © Davi Carvalho
