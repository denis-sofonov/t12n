---
layout: ../../layouts/Doc.astro
title: Vue & Nuxt
description: t12n validates ref / reactive state — type-driven, never firing on a plain DOM .value.
lang: en
---

# Vue & Nuxt

A Vue ref carries no annotation on the variable — the type lives in the generic
(`ref<User>()`), which a plain boundary scan would miss. So t12n detects Vue
reactivity directly:

```ts
const user = ref<User>()

// validated automatically — schema derived from the ref's element type
user.value = await fetch('/api/me').then(r => r.json())

// the initialiser is validated too
const state = reactive<User>(payload)
```

`ref`, `shallowRef`, `reactive` and `shallowReactive` initialisers are covered,
plus any `someRef.value = …` assignment. Detection is **type-driven**: it only
fires when the target really is a Vue ref, so a normal `.value` like a DOM
`input.value = …` is never touched.

This works in `.ts` / `.tsx` modules — composables, stores, API layers — **and**
in `.vue` SFCs: the plugin instruments the `<script setup>` block (or a plain
`<script lang="ts">`).

Don't use Vue? Drop `'vue'` from the `boundaries` option to skip the scan
entirely:

```ts
// vite.config.ts
t12n({
  mode: 'auto',
  boundaries: ['fetch', 'storage', 'json-parse', 'message-event', 'as-any', 'as-unknown'],
})
```
