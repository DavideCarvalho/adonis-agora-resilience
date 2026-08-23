---
name: resilience-custom-stores-testing
description: >-
  Choose, build and test circuit-breaker stores for @adonis-agora/resilience.
  Covers the ResilienceStore contract (admit/record/snapshot/reset) with
  Admission/BreakerConfig/CircuitSnapshot, config-driven stores.memory()/
  stores.lucid({ connection })/stores.redis({ connection }) in config/resilience.ts
  where EVERY listed store is built at boot, CIRCUITS_DDL + ensureResilienceSchema +
  autoCreateSchema:false migrations, lucidResilienceStore(db)/redisResilienceStore(client),
  custom engines via SqlResilienceStore + SqlDriver or the pure computeAdmit/computeRecord
  state machine (INITIAL_CIRCUIT_STATE) or StoreProvider thunks, defineConfig({ store }),
  circuitStore(name?), the snapshot()-lags-cooldown gotcha, atomic half-open probe
  guarantees, runResilienceStoreContract from @adonis-agora/resilience/testing, and
  FakeClock for deterministic timeout/backoff/cooldown tests. Use when sharing breaker
  state across instances, moving off in-memory, writing a custom store, or testing
  resilience time behavior.
metadata:
  type: core
  library: '@adonis-agora/resilience'
  library_version: '0.3.2'
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-resilience:docs/stores.mdx'
  - 'DavideCarvalho/adonis-resilience:docs/custom-store.mdx'
  - 'DavideCarvalho/adonis-resilience:docs/testing.mdx'
  - 'DavideCarvalho/adonis-resilience:packages/core/src/breaker/store.ts'
  - 'DavideCarvalho/adonis-resilience:packages/core/src/testing.ts'
---

# Circuit stores, custom backends and testing

The circuit breaker keeps its state — failure counts, open-until timestamps, the
half-open probe — behind one small interface. All three built-in implementations
ship in `@adonis-agora/resilience` itself and are selected in
`config/resilience.ts`; anything else you back it with must honor the same
contract:

```ts
interface ResilienceStore {
  admit(key: string, cfg: BreakerConfig): Promise<Admission>   // may I run? am I the probe?
  record(key: string, cfg: BreakerConfig, ok: boolean, probe: boolean): Promise<CircuitStatus>
  snapshot(key: string): Promise<CircuitSnapshot>              // read-only inspect
  reset(key: string): Promise<void>                            // back to closed
}
```

## Setup

Pick a default store and list the ones you use:

```ts
// config/resilience.ts
import { defineConfig, stores } from '@adonis-agora/resilience'

export default defineConfig({
  default: 'memory',
  stores: {
    memory: stores.memory(),                    // in-process, no peer dependency
    // lucid: stores.lucid({ connection: 'pg' }),   // requires @adonisjs/lucid installed
    // redis: stores.redis({ connection: 'main' }), // requires @adonisjs/redis + ioredis
  },
})
```

`default` decides which store breakers use; other entries stay reachable by name
through `resilience.circuitStore('lucid')`. The in-memory store is per-process —
to trip a breaker fleet-wide, point `default` at Lucid or Redis.

Source: `docs/stores.mdx § "Config-driven stores"`.

## Core patterns

### Pattern 1 — fleet-wide state with Redis (or SQL)

```sh
npm i @adonisjs/redis ioredis   # or: npm i @adonisjs/lucid
```

```ts
// config/resilience.ts
import { defineConfig, stores } from '@adonis-agora/resilience'

export default defineConfig({
  default: 'redis',
  stores: {
    redis: stores.redis({ connection: 'main' }), // omit `connection` for the default
  },
})
```

Redis runs `admit`/`record` as single server-side Lua scripts (atomic, no
schema); Lucid uses `SELECT … FOR UPDATE` on Postgres/MySQL and plain
transactions on SQLite. Both coordinate the half-open probe atomically, so
exactly one instance probes a recovering dependency.

Source: `docs/stores.mdx § "Distributed stores"`.

### Pattern 2 — own the schema with a migration

Auto-create (`CREATE TABLE IF NOT EXISTS`, via `CIRCUITS_DDL`) is convenient for
getting started; in production disable it and run the DDL from a migration so
you get a `down()`:

```ts
// database/migrations/XXXX_create_resilience_circuits.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('resilience_circuits', (table) => {
      table.text('key').primary()
      table.text('status').notNullable().defaultTo('closed')
      table.integer('failures').notNullable().defaultTo(0)
      table.bigInteger('open_until').notNullable().defaultTo(0)
      table.integer('probes').notNullable().defaultTo(0)
    })
  }

  async down() {
    this.schema.dropTable('resilience_circuits')
  }
}
```

```ts
// config/resilience.ts
export default defineConfig({
  default: 'lucid',
  stores: { lucid: stores.lucid({ connection: 'pg', autoCreateSchema: false }) },
})
```

For tests/scripts, `ensureResilienceSchema(db)` runs the idempotent DDL against
any client with a `rawQuery` method — including a transaction client.

Source: `docs/stores.mdx § "Lucid: migration over auto-create"`,
`packages/core/src/stores/lucid.ts`.

### Pattern 3 — a custom engine by reuse tier

Pick the highest tier your engine allows; finish every tier with the contract
suite (Pattern 4). Tier 1 — any SQL engine: implement a thin `SqlDriver`
(`placeholders: 'numbered' | 'positional'`, optional `lockRows`, `transaction`,
`read`, `exec`) and hand it to `SqlResilienceStore`, which owns the whole atomic
cycle and the statements:

```ts
import { SqlResilienceStore, type SqlDriver } from '@adonis-agora/resilience'

const driver: SqlDriver = {
  placeholders: 'numbered', // '$1, $2' (Postgres/Prisma/TypeORM) or 'positional' ('?')
  lockRows: true,           // false on engines without SELECT … FOR UPDATE (e.g. SQLite)
  transaction: (body) =>
    pool.transaction((tx) =>
      body({
        run: (sql, params) => tx.query(sql, params).then(() => undefined),
        all: (sql, params) => tx.query(sql, params).then((r) => r.rows),
      }),
    ),
  read: (sql, params) => pool.query(sql, params).then((r) => r.rows),
  exec: (sql) => pool.query(sql).then(() => undefined),
}

const store = new SqlResilienceStore(driver)
await store.ensureSchema() // runs CIRCUITS_DDL
```

Tier 2 — non-SQL engine with JS-level atomicity: drive the pure state machine
yourself inside an atomic primitive. A new key loads as `INITIAL_CIRCUIT_STATE`;
both functions take `now` as an argument, so thread a `Clock` through
(default `systemClock`, inject `FakeClock` in tests):

```ts
import {
  computeAdmit,
  computeRecord,
  INITIAL_CIRCUIT_STATE,
  type Clock,
  type ResilienceStore,
} from '@adonis-agora/resilience'

class MyStore implements ResilienceStore {
  constructor(private clock: Clock = systemClock) {}

  async admit(key: string, cfg: BreakerConfig): Promise<Admission> {
    return this.engine.atomically(key, async (tx) => {
      const prev = (await tx.load(key)) ?? { ...INITIAL_CIRCUIT_STATE }
      const { state, admission } = computeAdmit(prev, cfg, this.clock.now())
      await tx.save(key, state)
      return admission
    })
  }
  // record(): same loop with computeRecord(prev, cfg, ok, probe, now)
  // snapshot(): read-only projection; reset(): delete/clear the key
}
```

Wire either one in as `defineConfig({ store })` (single explicit instance,
takes precedence over `default`/`stores`), or give it a name with a
`StoreProvider` thunk that receives `{ app }` at boot and can resolve the
container — import optional drivers *inside* the thunk so they stay optional:

```ts
// app/lib/mongo_resilience_store.ts
import type { StoreProvider } from '@adonis-agora/resilience'

export function mongoStore(config: { collection?: string } = {}): StoreProvider {
  return async ({ app }) => {
    const mongo = await app.container.make('mongo')
    return new MongoResilienceStore(mongo, config.collection ?? 'resilience_circuits')
  }
}

// config/resilience.ts → default: 'mongo', stores: { mongo: mongoStore() }
```

Source: `docs/custom-store.mdx` (all tiers + "Wiring it in"),
`docs/stores.mdx § "Bring your own engine"`.

### Pattern 4 — validate with the contract suite, test time with FakeClock

Every custom store must pass the same suite the built-ins do; it registers a
Vitest `describe` block covering the transition table and the invariant that N
concurrent `admit` calls in half-open yield exactly one probe. The factory
receives a `Clock` the suite controls — thread it into your store:

```ts
// my-store.contract.spec.ts
import { runResilienceStoreContract } from '@adonis-agora/resilience/testing'
import { MyResilienceStore } from './my-store.js'

runResilienceStoreContract('MyResilienceStore', (clock) => new MyResilienceStore({ clock }))
```

The same clock seam makes policy timing deterministic — `timeout`, `retry`, and
the stores all accept `{ clock }`; `FakeClock.advance(ms)` fires due timers in
scheduled order instantly:

```ts
import { FakeClock, InMemoryResilienceStore, circuitBreaker, BrokenCircuitError } from '@adonis-agora/resilience'

const clock = new FakeClock()
const store = new InMemoryResilienceStore(clock)
const breaker = circuitBreaker({ key: 'svc', store, threshold: 1, cooldownMs: 5_000 })

await expect(breaker.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow()
await expect(breaker.execute(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(BrokenCircuitError)

clock.advance(5_000) // cooldown elapses → half-open, no real waiting
await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok') // probe closes it

expect((await store.snapshot('svc')).status).toBe('closed')
await store.reset('svc') // force back to closed between tests
```

Source: `docs/testing.mdx § "Validating a store"` and `§ "The clock seam"`,
`packages/core/src/testing.ts`.

## Common mistakes

### CRITICAL Listing stores whose peer dependencies are not installed

Wrong:

```ts
// @adonisjs/lucid NOT installed:
export default defineConfig({
  default: 'memory',
  stores: {
    memory: stores.memory(),
    lucid: stores.lucid({ connection: 'pg' }), // built at boot anyway → app fails to start
  },
})
```

Correct:

```ts
export default defineConfig({
  default: 'memory',
  stores: { memory: stores.memory() }, // list only stores whose peers you have installed
})
```

Mechanism: each `stores.*` call returns a lazy thunk, but the provider builds
**every** entry of the map when it first resolves the service — not just the one
`default` names — and each Lucid/Redis thunk imports its optional peer as it is
built; a peer you never list is never imported, which is what keeps those
packages optional.

Source: `docs/stores.mdx Callout "Every listed store is built at boot"`,
`docs/custom-store.mdx` warning

### MEDIUM Building dashboards or health checks on raw `snapshot()` output

Wrong:

```ts
const snap = await store.snapshot('payments')
if (snap.status === 'open') throw new Error('circuit open') // stale after the cooldown elapsed
```

Correct:

```ts
const snap = await store.snapshot('payments')
const cooledDown = snap.openUntil !== undefined && Date.now() >= snap.openUntil
if (snap.status === 'open' && !cooledDown) throw new Error('circuit open')
```

Mechanism: `snapshot()` reads stored state without transitioning — only
`admit()` advances the state machine, so a circuit whose cooldown has already
elapsed still reports `status: 'open'` until the next call goes through it.

Source: `docs/stores.mdx Callout "snapshot() does not advance the cooldown"`

### HIGH Writing a custom store whose `admit`/`record` are not atomic

Wrong:

```ts
async admit(key, cfg) {
  const prev = await db.load(key)                       // separate round-trips:
  const { state, admission } = computeAdmit(prev ?? INITIAL_CIRCUIT_STATE, cfg, Date.now())
  await db.save(key, state)                             // two instances interleave under load
  return admission                                      // → both win the probe
}
```

Correct:

```ts
async admit(key, cfg) {
  return this.engine.atomically(key, async (tx) => {
    const prev = (await tx.load(key)) ?? { ...INITIAL_CIRCUIT_STATE }
    const { state, admission } = computeAdmit(prev, cfg, this.clock.now())
    await tx.save(key, state)
    return admission
  })
}
```

Mechanism: the distributed guarantee — exactly ONE instance gets the half-open
probe under concurrent load — depends on load→compute→persist being indivisible
(FOR UPDATE row locks, Lua, or compare-and-swap); naive read-then-write lets two
instances double-hammer a recovering dependency.

Source: `docs/custom-store.mdx "The interface you are implementing"`,
`docs/stores.mdx` atomicity Callout

### HIGH Skipping `runResilienceStoreContract` for a from-scratch store

Wrong:

```ts
describe('MyLuaStore', () => {
  it('opens after threshold failures', ...) // hand-picked happy-path cases only
})
```

Correct:

```ts
import { runResilienceStoreContract } from '@adonis-agora/resilience/testing'

runResilienceStoreContract('MyLuaStore', (clock: Clock) => new MyLuaStore(clock))
```

Mechanism: a Tier-3 (server-side) implementation must stay byte-for-byte faithful
to `computeAdmit`/`computeRecord`, and the shared suite is the only guard against
drift — it hammers atomicity and the transition table exactly like the built-in
Lucid/Redis adapters are verified.

Source: `docs/custom-store.mdx Callout "You are now the source-of-truth twin"` +
`§ "Validate against the contract suite"`

### MEDIUM Testing cooldowns and backoff with real timers

Wrong:

```ts
await breaker.execute(() => Promise.reject(new Error('boom')))
await new Promise((r) => setTimeout(r, 30_000)) // 30s test, still timing-sensitive
```

Correct:

```ts
const clock = new FakeClock()
const store = new InMemoryResilienceStore(clock)
const breaker = circuitBreaker({ key: 'svc', store, threshold: 1, cooldownMs: 5_000 })

await expect(breaker.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow()
clock.advance(5_000) // instant half-open
```

Mechanism: resilience is full of time and every time-dependent policy/store takes
an injectable `Clock`; sleeping through cooldowns makes suites slow and flaky
where `FakeClock.advance(ms)` fires due timers instantly in scheduled order.

Source: `docs/testing.mdx § "The clock seam"`

See also: `resilience-setup-policies/SKILL.md` — how `circuitStore(name?)` and
named policies resolve the stores registered here.
See also: `resilience-decorator/SKILL.md` — decorated breakers need one of these
stores passed explicitly at class-definition time.
