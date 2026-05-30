---
layout: ../../layouts/Doc.astro
title: Errors & configure
description: Decide what happens when a check fails — throw in dev, report in production.
lang: en
---

# Errors & configure

When a check fails, what *should* happen is a per-stage decision the bundle
can't make for you:

- **dev** — fail loud: throw, or `console.warn` and keep going.
- **production** — a bad API payload should be telemetry, not a white screen:
  report it to your backend and let the app live.

## Setting a policy — `configure`

You wire that policy once, at app entry:

```ts
import { configure } from 't12n'

configure({
  onViolation: import.meta.env.PROD
    ? ({ error, path }) =>
        navigator.sendBeacon('/t12n', JSON.stringify({ path, msg: error.message }))
    : ({ error }) => console.warn(error.message),
})
```

The same handler fires for both boundary failures and live mutations, and the
context tells them apart:

```ts
interface ViolationContext {
  site: 'boundary' | 'mutation'   // entered bad, or mutated out-of-type
  path: string                    // 'user.address.zip'
  error: ValidationError          // also what gets thrown by default
  issue: ValidationIssue
  value: unknown                  // the offending value
  schema: Schema                  // what it was checked against
  source?: string                 // 'src/pages/Profile.vue:42' — when embedded
  boundary?: string               // 'fetch().json()' — when known
}
```

The rule is simple:

- **No handler** (the default) → the `ValidationError` is **thrown**. Fail-fast.
- **Handler returns normally** → t12n does **not** throw. A boundary value
  passes through unchanged; a mutation is applied. This is the "report, don't
  crash" path.
- **Handler throws** → that propagates. Re-throw `ctx.error` to abort while
  keeping the original message and stack.

Pass `configure({ onViolation: null })` to restore the throwing default.

## `ValidationError`

`ValidationError` carries the full picture, so you can render it, log it, or
test against it:

```ts
class ValidationError extends Error {
  readonly path: string                 // 'user.address.zip'
  readonly expected: string             // 'string'
  readonly received: unknown            // 12345
  readonly issues: ValidationIssue[]    // EVERY failing field of this boundary
  readonly source?: string              // 'src/pages/Profile.vue:42'
  readonly boundary?: string            // 'fetch().json()'
}

interface ValidationIssue {
  path: string
  expected: string
  received: unknown
  nested?: ValidationIssue[]
}
```

Catch it with a plain `instanceof`:

```ts
import { ValidationError } from 't12n'

try {
  doSomething()
} catch (e) {
  if (e instanceof ValidationError) {
    console.warn('bad data at', e.path, '— expected', e.expected)
  }
}
```

That's the whole user-facing API. `t12n` exposes just two runtime things:
`ValidationError`, for `instanceof` checks in your `catch` blocks, and
`configure`, for the one-time policy above. There's no `validate()`, no
`safeValidate()`, nothing to call per value. The plugin does the calling; you
write types.

## Every failing field, in one error

One boundary throws **one** `ValidationError` — but it carries **all** the
fields that failed, not just the first. When a payload is wrong in several
places you see them together:

```
[t12n] Validation failed · src/user.ts:7  (fetch().json()) — 3 issues

  id
    expected   string
    received   number (1)
  email
    expected   string
    received   null
  age
    expected   number
    received   string ("20")
```

`error.issues` is that list; `error.path` / `.expected` / `.received` mirror the
first entry, so simple code keeps working. The valid path is untouched —
gathering the full list happens only once a check has already failed, so it
never slows down good data.

> Lean production builds with `emitSchema: false` carry no schema at runtime, so
> an AOT boundary there reports just the first failing field. Dev, and any build
> with the schema present, list them all.

## Where the error points — `errorLocation`

The plugin can embed the **original source location** (`file:line`) and the
**boundary** that produced the value, so a failure reads like:

```
[t12n] Validation failed · src/pages/Profile.vue:42  (fetch().json())

  user.email
    expected   string
    received   null
```

That `source` and `boundary` also land on `error.source` / `error.boundary` and
on the `ViolationContext`, so your telemetry handler can group failures by
origin.

It's controlled by the plugin's `errorLocation` option:

```ts
// vite.config.ts
t12n({ mode: 'auto', errorLocation: 'auto' })
```

| `errorLocation` | Behaviour |
| :--- | :--- |
| `'auto'` | **Default** — embed on the dev server, omit in production builds (keeps the bundle lean) |
| `true` | Always embed — useful when you ship boundary failures to telemetry |
| `false` | Never embed |
