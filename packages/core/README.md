# `@adonis-agora/resilience`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/resilience)](https://www.npmjs.com/package/@adonis-agora/resilience) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/resilience)](https://www.npmjs.com/package/@adonis-agora/resilience) [![CI](https://github.com/DavideCarvalho/adonis-agora-resilience/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-resilience/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/resilience)](https://www.npmjs.com/package/@adonis-agora/resilience)

Resilience policies for AdonisJS — timeout, retry, circuit breaker, ordered
failover — with pluggable circuit stores. Part of the Agora ecosystem.

```sh
npm i @adonis-agora/resilience
node ace configure @adonis-agora/resilience
```

```ts
import { wrap, timeout, retry, circuitBreaker } from '@adonis-agora/resilience'
const policy = wrap(timeout(2000), retry({ attempts: 3 }))
await policy.execute(() => doWork())
```

See the [repository README](https://github.com/DavideCarvalho/adonis-resilience).

## License

MIT © Davi Carvalho
