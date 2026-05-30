---
layout: ../../layouts/Doc.astro
title: Boundaries & modes
description: What t12n treats as a boundary, and the auto / manual / off modes.
lang: en
---

# Boundaries & modes

A *boundary* is any place where data you did not write yourself enters your
program. Inside your code the types are guaranteed by the compiler. At a
boundary they're only an assumption about data you don't control — t12n checks
that assumption so you don't have to trust it.

## What gets detected

In `mode: 'auto'` the plugin recognises these boundaries by default:

- `fetch().json()`, `fetch().text()`, `fetch().formData()`
- `JSON.parse(...)`
- `localStorage.getItem(...)` and `sessionStorage.getItem(...)`
- `event.data` on a `MessageEvent`-typed receiver (postMessage,
  BroadcastChannel, Worker, WebSocket, EventSource)
- `as any` and `as unknown` casts at variable declarations
- Vue/Nuxt reactivity — see [Vue & Nuxt](/guide/vue)

When the variable on the left has an explicit, non-primitive type annotation,
the initializer is wrapped. Typed function parameters and return values are
covered too — see [Functions](/guide/functions).

You can narrow the set with the `boundaries` option if you only want some of
them:

```ts
// vite.config.ts
t12n({ mode: 'auto', boundaries: ['fetch', 'json-parse'] })
```

## The three modes

The plugin runs in one of three modes, set in your Vite config:

| Mode | Where checks go |
| :--- | :--- |
| `auto`   | Every boundary above, plus any typed function parameter and return |
| `manual` | Only where you write `Check<T>` |
| `off`    | Nothing — the plugin is inert (compile-time types still apply) |

`auto` is the default. Both modes use the same engine; only the trigger
differs.

## When a type can't be validated

t12n is only as honest as your types. If a boundary's type resolves to `any`,
`unknown`, or a shape t12n can't model yet, there's nothing to check — wrapping
it would emit a validator that passes everything, a silent hole that *looks*
guarded. So instead the plugin **skips that site and reports it**, controlled by
`onUnvalidated`:

```ts
// vite.config.ts
t12n({ mode: 'auto', onUnvalidated: 'warn' })
```

| `onUnvalidated` | Behaviour |
| :--- | :--- |
| `'warn'` | **Default** — log each unvalidated boundary (`file:line` + which boundary) during the build |
| `'error'` | Fail the build — use in CI to forbid unvalidated boundaries |
| `'off'` | Skip silently |

A typical warning:

```
[t12n] src/api.ts:12 — fetch().json() has a type t12n can't validate
       (any/unknown); left unchecked. Tighten the type or annotate Check<T>.
```

The fix is almost always to give the boundary a concrete type (or a
`Check<T>`). Auto-mode function parameters are too numerous to warn on, so only
an explicit `Check<T>` that can't be validated is reported there.

## Manual mode — `Check<T>`

Sometimes you want explicit, opt-in checks instead of blanket detection. Switch
the plugin into `manual` mode:

```ts
// vite.config.ts
t12n({ mode: 'manual' })
```

Now ordinary annotations are left alone. To request a check, use the `Check<T>`
marker type at the assignment, parameter or return site:

```ts
import type { Check } from 't12n'
import type { User } from './types'

// plain annotation: nothing happens
const a: User = somewhere()

// Check<User>: the plugin sees the marker and inserts the check
const b: Check<User> = somewhereElse()
```

`Check<T>` is just `T` at compile time — no narrowing, no brand. The why is in
[Core concepts](/guide/concepts#checkt--the-marker-type). It works anywhere
TypeScript accepts a type annotation.

## Off mode

```ts
t12n({ mode: 'off' })
```

The plugin becomes inert. The DOM overrides from `t12n` still apply at compile
time — useful when you want only the type-level pressure, with zero runtime
cost.
