---
layout: ../../layouts/Doc.astro
title: Core concepts
description: The boundary, the Check<T> marker, the Unvalidated<T> brand, and three principles.
lang: en
---

# Core concepts

A few ideas explain how t12n works. Once you have them, the rest of the API is
easy to follow.

## The boundary

A *boundary* is any place where data you did not write yourself enters your
program — a `fetch` response, `localStorage`, a `postMessage`, a `JSON.parse`.

Inside your code the types are guaranteed by the compiler. At a boundary they're
only an *assumption* about data you don't control. t12n checks that assumption
so you don't have to trust it. Which boundaries are detected, and how to control
them, is covered in [Boundaries & modes](/guide/boundaries).

## `Check<T>` — the marker type

`Check<T>` is an identity type:

```ts
type Check<T> = T
```

At compile time it behaves exactly like `T`: no narrowing, no brand, nothing at
runtime. The plugin recognises the annotation by name and reads it as: "derive a
schema for `T` and wrap the right-hand side in a check here."

```ts
const u: Check<User> = somewhere()       // variable
function f(u: Check<User>) { /* … */ }   // parameter
function g(): Check<User> { /* … */ }    // return type
```

Anywhere TypeScript accepts a type annotation, `Check<T>` works. The plugin also
rewrites the emitted type back to plain `T`, so downstream consumers see the
clean shape. It's the explicit trigger for
[`manual` mode](/guide/boundaries#manual-mode--checkt).

## `Unvalidated<T>` — the boundary brand

Two branded types live in the package:

```ts
type Unvalidated<T> = T & { readonly [__unvalidated]: true }
type Validated<T>   = T & { readonly [__validated]:   true }
```

The brand is a `unique symbol`, so nothing outside the package can forge it.
With the DOM overrides loaded (via `/// <reference types="@dnssfnv/t12n" />`), `fetch().json()`
returns `Promise<Unvalidated<unknown>>` — and the compiler refuses to let you
use that as anything else until it has passed through a check.

Auto mode lifts the brand: when t12n inserts a runtime check at a typed
boundary, the result is treated as `T` (no longer `Unvalidated<T>`) at the use
sites that follow.

## Three principles

1. **The type is the source of truth.** Schemas come from your TypeScript types,
   so there's no second definition that can drift out of sync.
2. **You opt in by location, not by call.** What gets checked depends on *where*
   you put the type annotation, not on calling a function.
3. **Failures are loud and precise.** When data doesn't match, the error names
   the field, the expected type and the actual value, and it fires on the line
   where the data came in.

That's the whole model. For what runs underneath — schema derivation and the
compiled validator — see [the engine](/guide/engine).
