---
layout: ../../layouts/Doc.astro
title: Under the hood — the engine
description: How schemas are derived from resolved types, and compiled into per-type validators.
lang: en
---

# Under the hood — the engine

Two things happen: a schema is derived from your type at build, and a validator
runs against the data at runtime. Both are designed to disappear — nothing to
write, nothing you can feel.

## Schemas come from *resolved* types

The plugin never parses type *syntax*. It asks the TypeScript checker (through
ts-morph) for the **resolved** type at each site. So anything the compiler can
reduce to a concrete shape is fair game — generics, indexed access, conditional
types, mapped types, utility types (`Partial`, `Pick`, `Omit`, `Required`). By
the time t12n sees the type, it's already a plain structure.

```ts
type EventMap = {
  user:    { id: string; name: string; role: 'admin' | 'user' }
  payment: { amount: number; currency: string; timestamp: Date }
}
type EventData<T extends keyof EventMap> = EventMap[T]

// a conditional + indexed type at a boundary:
const p: EventData<'payment'> = JSON.parse(raw)
```

t12n resolves `EventData<'payment'>` first, then derives the schema:

```
{ amount: number, currency: string, timestamp: Date (instanceof) }
```

No special case for the conditional/indexed type — the checker reduced it before
t12n looked. Mapped types, nested index access (`System[K]['config']`),
`T | null`, arrays and enums all come out the same way. Built-in classes
(`Date`, `Map`, `Set`, `RegExp`, typed arrays) are checked with `instanceof`; an
index signature (`{ [k: string]: T }`) becomes a record; a template-literal type
validates as a string.

## Two-tier runtime

For production builds the plugin **compiles each type into a dedicated validator
function** and bakes it into the bundle — at runtime no schema is interpreted:

```ts
// generated once per type, hoisted into the module
const __v0 = (v) => {
  if (v === null || typeof v !== 'object') return fail('', 'object', v)
  if (typeof v.amount   !== 'number') return fail('amount', 'number', v.amount)
  if (typeof v.currency !== 'string') return fail('currency', 'string', v.currency)
  if (!(v.timestamp instanceof Date)) return fail('timestamp', 'Date', v.timestamp)
  return { amount: v.amount, currency: v.currency, timestamp: v.timestamp }
}
```

Straight-line code with **static property access** — exactly what you'd write by
hand. Recursive types and the live Proxy guard fall back to a compact
tree-walking interpreter; everything else takes the compiled path. There's no
`eval` / `new Function` at runtime, so it works under a strict
Content-Security-Policy.

## It's effectively free

The generated validator never coerces, and it allocates nothing for data that
already matches: unknown keys are stripped copy-on-write, so a clean object is
returned as-is. In the repo's benchmark (an array of 100 nested objects):

| | ops/s | relative |
| :--- | ---: | ---: |
| by hand | ~775,000 | ~1.2× faster |
| **t12n (compiled)** | **~640,000** | baseline |
| Zod v4 | ~75,000 | ~8.5× slower |

About **8× faster than Zod**, and within ~20% of a validator written by hand for
this exact type — because the generated code *is* essentially that. Fast enough
that the check is invisible next to the network request or `JSON.parse` that
produced the data. Run it yourself with `node bench/runtime.bench.mjs`.
