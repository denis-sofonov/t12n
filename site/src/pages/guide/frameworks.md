---
layout: ../../layouts/Doc.astro
title: Frameworks
description: t12n is bundler-driven — React, Next.js, Vue/Nuxt, Svelte, Solid and any Vite/webpack/Rollup/esbuild/Rspack build.
lang: en
---

# Frameworks

t12n is **bundler-driven, not framework-specific**. The plugin runs through
[unplugin](https://unplugin.unjs.io/), so the same engine plugs into Vite,
webpack, Rollup, esbuild and Rspack — and the validation it inserts is plain
JavaScript that runs anywhere (browser, Node, edge).

## Bundler entrypoints

Pick the one your tool uses — it's the same plugin:

| Bundler | Import |
| :--- | :--- |
| Vite | `@dnssfnv/t12n/vite` |
| webpack | `@dnssfnv/t12n/webpack` |
| Rollup | `@dnssfnv/t12n/rollup` |
| esbuild | `@dnssfnv/t12n/esbuild` |
| Rspack | `@dnssfnv/t12n/rspack` |

## React

React needs **no special setup on Vite**. The generic boundaries —
`fetch().json()`, `JSON.parse`, `localStorage`, `as any` — work in `.tsx` out of
the box, and each type still compiles to its own validator.

With the `react` boundary (on by default) t12n also:

- validates `useState<T>(init)` / `useRef<T>(init)` initialisers against `T`;
- **skips the params and returns of components** (PascalCase) and **hooks**
  (`use…`) in auto mode — those are compiler-checked internals, not boundaries,
  so t12n won't instrument every prop. Opt one in explicitly with `Check<T>`.

```tsx
// payload validated against User
const [user, setUser] = useState<User>(payload)

// validated — a real boundary
const data: ApiData = await fetch('/api').then(r => r.json())

// NOT instrumented — props are internal, compiler-checked
function Card({ user }: { user: User }) { /* … */ }
```

## Next.js

Next builds with webpack, so wire t12n through `@dnssfnv/t12n/webpack`:

```js
// next.config.js
import t12n from '@dnssfnv/t12n/webpack'

export default {
  webpack(config) {
    config.plugins.push(t12n())
    return config
  },
}
```

The runtime is plain JS, so checks run in the browser, in Node (API routes,
server components) and at the edge.

> **Turbopack isn't supported yet.** It has no source-transform plugin API, and
> t12n's type → schema step needs the TypeScript checker, which can't run inside
> it. Use the webpack build for now (`next build`, or `next dev` without
> `--turbo`).

## Vue / Nuxt

Fully supported via the `vue` boundary: `ref` / `shallowRef` / `reactive`
initialisers, `someRef.value = …` assignments, and `.vue` SFCs (the plugin
instruments `<script setup>` or a plain `<script lang="ts">`).

## Solid

The `solid` boundary validates `createSignal<T>(init)` and
`createStore<T>(init)` initialisers against `T`:

```tsx
const [user, setUser] = createSignal<User>(payload)  // payload validated
```

## Svelte / SvelteKit

The `svelte` boundary parses `.svelte` SFCs and validates the `$state(init)`
rune — the type comes from `$state<T>(…)` or the `let x: T` annotation:

```svelte
<script lang="ts">
  let user: User = $state(payload)   // payload validated against User
</script>
```

## Anything else

The Vite/webpack/Rollup/esbuild/Rspack plugin plus the generic boundaries
(fetch / parse / storage / casts) work in **Astro, Remix and any TS project**.
And [`Check<T>`](/guide/boundaries#manual-mode--checkt) gives you an explicit
check anywhere TypeScript accepts a type annotation.
