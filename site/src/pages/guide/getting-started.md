---
layout: ../../layouts/Doc.astro
title: Getting started
description: Install t12n, add the Vite plugin, reference the types — then write normal TypeScript.
lang: en
---

# Getting started

Setup takes about five minutes: install the package, add the Vite plugin, and
reference the types in your tsconfig. After that you write normal TypeScript and
t12n inserts the checks for you.

## Install

```bash
npm i @dnssfnv/t12n
# also: pnpm add @dnssfnv/t12n · yarn add @dnssfnv/t12n · bun add @dnssfnv/t12n
```

That one package contains everything: the Vite plugin, the runtime, the DOM
type overrides and the `Check<T>` marker type.

## Reference the types

Add a one-line triple-slash reference in any ambient `.d.ts` your project
already includes (e.g. `env.d.ts`, or a new `t12n.d.ts`):

```ts
/// <reference types="@dnssfnv/t12n" />
```

This loads the DOM overrides that mark `fetch().json()`, `localStorage.getItem`,
and friends as `Unvalidated<T>`, and makes the `Check<T>` marker type available.

> Prefer the reference over `"types": ["@dnssfnv/t12n"]` in `tsconfig.json` — setting the
> `types` array there turns off automatic inclusion of every *other* ambient
> package (`node`, `vite/client`, test globals…). The reference loads t12n's
> globals without that side effect. It's optional, too: runtime checks work
> without it — it only adds the compile-time pressure and the global `Check<T>`
> (which you can also just `import type { Check } from '@dnssfnv/t12n'`).

## Register the Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import t12n from '@dnssfnv/t12n/vite'

export default defineConfig({
  plugins: [t12n()],
})
```

That's the only config you write — `t12n()` runs in `auto` mode by default. The
rest is automatic.

## Your first check

You don't import or call anything. Put a type annotation on data that comes from
outside, and the plugin spots the boundary, derives a schema from the type, and
inserts the check at the right place:

```ts
import type { User } from './types'

const user: User = await fetch('/api/me').then(r => r.json())

console.log(user.email)
```

At build time this becomes, in essence:

```ts
import { __check } from '@dnssfnv/t12n/runtime'

const user = __check(
  await fetch('/api/me').then(r => r.json()),
  { kind: 'object', properties: {
    id:    { kind: 'string' },
    email: { kind: 'string' },
    age:   { kind: 'number' },
  } }
)
```

The schema is **plain data**, not Zod calls — t12n ships its own validator with
zero runtime dependencies. This `__check` form is the readable model; production
builds [compile each type into a dedicated function](/guide/engine) that runs
~8× faster than Zod. If the response doesn't match `User`, you get a
`ValidationError` naming the exact path, the expected type, and the value that
arrived.

## Where to go next

- [Boundaries & modes](/guide/boundaries) — what's detected, and `auto` /
  `manual` / `off`.
- [Vue & Nuxt](/guide/vue) — validating `ref` / `reactive` state.
- [Functions](/guide/functions) — typed parameters and returns.
- [Live mode](/guide/live-mode) — keep the type enforced past the boundary.
- [Errors & configure](/guide/errors) — decide what happens on failure.
- [Core concepts](/guide/concepts) and [the engine](/guide/engine) — how it all
  works underneath.
