# t12n

**Type-driven runtime validation.** A build plugin that turns your TypeScript
types into runtime validators — annotate the data that crosses a boundary, and
the schemas, checks and errors write themselves. Decoded: t + 12 letters + n =
*typevalidation*.

- **~3 KB** gzipped runtime · **zero runtime dependencies** · no `z.xxx()` in your code
- Schemas derived from your TS types at build (via ts-morph) — generics, unions,
  `Date`/`Map`/`Set`, records, recursive types and all
- Compiles each type into a dedicated validator, **~8× faster than Zod**
- Works with Vite, webpack, Rollup, esbuild, Rspack — React, Vue, Svelte, Solid,
  Next, Nuxt, Astro
- No `eval` at runtime — CSP-safe; runs in the browser, Node and at the edge

> Status: **v0.1, beta.** APIs may still shift.

## Install

```bash
npm install t12n
```

## Setup

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import t12n from 't12n/vite'

export default defineConfig({ plugins: [t12n()] }) // 'auto' mode by default
```

```ts
// any ambient .d.ts (env.d.ts, t12n.d.ts) — loads the DOM overrides + Check<T>
/// <reference types="t12n" />
```

Prefer the reference over `"types": ["t12n"]` in tsconfig (the `types` array
disables auto-inclusion of every other ambient package). It's optional — runtime
checks work without it; it only adds the compile-time pressure.

Other bundlers expose the same plugin: `t12n/webpack`, `t12n/rollup`,
`t12n/esbuild`, `t12n/rspack`. For **Next.js**, add `t12n/webpack` in
`next.config.js` (Turbopack isn't supported yet — use the webpack build).

## Use

Annotate a boundary; the plugin inserts the check.

```ts
import type { User } from './types'

const user: User = await fetch('/api/me').then(r => r.json())
// ↑ at build, compiled to a dedicated validator generated from User.
//   A bad payload throws a ValidationError naming the file, line, path,
//   the expected type and what actually arrived.
```

Detected automatically: typed variables, function params/returns, `JSON.parse`,
`localStorage`/`sessionStorage`, `MessageEvent.data`, `as any`/`as unknown`
casts, and framework state — Vue `ref`/`reactive`, React `useState`, Solid
`createSignal`, Svelte `$state`.

## Modes

| Mode | Detection |
| :--- | :--- |
| `auto` (default) | every typed boundary + typed function params/returns |
| `manual` | only sites annotated with `Check<T>` |
| `off` | no-op (compile-time types still apply) |

## Live mode + failure policy

Opt into a Proxy guard that keeps the type enforced for the object's whole life
(catches later off-type mutations too), and decide per stage what a failure does:

```ts
import { configure } from 't12n'

configure({
  onViolation: import.meta.env.PROD
    ? ({ error, path }) => report(path, error) // prod: ship it, app lives
    : ({ error }) => { throw error },          // dev: fail loud
})
```

```ts
t12n({ mode: 'auto', live: true }) // Proxy guard (default: dev server only)
```

The `ValidationError` carries `path`, `expected`, `received`, and — when
`errorLocation` is on (dev by default) — the `source` (`file:line`) and the
`boundary` that produced the value.

## Docs

Full guide, concepts and an interactive playground: **https://t12n.dev**

## License

MIT © Denis Sofonov
