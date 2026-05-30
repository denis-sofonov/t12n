---
layout: ../../layouts/Doc.astro
title: Functions
description: Typed parameters and return values get the same automatic check as any boundary.
lang: en
---

# Functions

Any function with typed parameters or a typed return value gets the same
treatment as a boundary — with no checks written by you:

```ts
function processUser(user: User): UserResult {
  return computeSomething(user)
}
```

becomes, at build time:

```ts
function processUser(user): UserResult {
  user = check(user, /* schema for User */)
  return check(computeSomething(user), /* schema for UserResult */)
}
```

A bad payload at the call site fails *before* `computeSomething` runs. A buggy
implementation that returns the wrong shape fails *before* the value leaves the
function.

In a production build each of those checks is a [compiled
validator](/guide/engine), not an interpreted schema — so the guarantee is
effectively free.
