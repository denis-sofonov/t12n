---
layout: ../../layouts/Doc.astro
title: Live mode
description: Keep the type enforced for the object's whole lifetime, not just at the boundary.
lang: en
---

# Live mode

By default a check runs **once**, at the boundary, and hands you an ordinary
object. Nothing stops that object from drifting a moment later:

```ts
const user: User = await fetch('/api/me').then(r => r.json())
// checked ✓
user.age = 'twenty'   // ✗ not checked again — nothing catches this
```

Zod, Valibot and the rest work the same way: they check once and return a plain
object.

**Live mode** keeps the type alive for the object's whole lifetime. Instead of
the one-shot check, the plugin emits a guard that validates the same way and
then returns a recursive `Proxy`:

- writing an off-type value to a known property is caught;
- writing a property the type doesn't declare is caught;
- deleting a required property is caught;
- nested objects, arrays, records and tuples are wrapped lazily on first read
  (identity is preserved — `user.address === user.address`).

```ts
const user: User = await fetch('/api/me').then(r => r.json())

user.age = 'twenty'   // 💥 ValidationError at "user.age" — caught live
```

## Turning it on

It's controlled by the plugin's `live` option:

```ts
// vite.config.ts
t12n({
  mode: 'auto',
  live: true,   // force the guard on for every build
})
```

| `live` | Behaviour |
| :--- | :--- |
| `true`  | Emit the Proxy guard — mutations are watched too |
| `false` | Emit the one-shot check — validate at the boundary only |
| *(unset)* | **Default**: `true` on the dev server (`vite serve`), `false` for production builds |

Live mode is orthogonal to `auto` / `manual` / `off`: the mode decides *where*
checks go, `live` decides *whether* they keep watching afterwards. Set it to
`true` to watch mutations in production too (pair it with a reporting handler —
see [Errors & configure](/guide/errors)), or `false` to never use Proxies.

## The cost

There's a real cost: every property access on a guarded object goes through a
trap. That's why the default keeps Proxies in dev and ships the cheap compiled
check to production. Proxies also don't survive structured-clone boundaries
(`postMessage`, workers) — the receiving side just re-guards at its own
boundary.
