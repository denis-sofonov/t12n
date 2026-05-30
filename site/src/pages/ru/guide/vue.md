---
layout: ../../../layouts/Doc.astro
title: Vue и Nuxt
description: t12n валидирует ref / reactive-состояние — по типу, не трогая обычный DOM .value.
lang: ru
---

# Vue и Nuxt

У Vue-ref'а нет аннотации на переменной — тип живёт в дженерике (`ref<User>()`),
который обычный скан границ пропустил бы. Поэтому t12n детектит Vue-реактивность
напрямую:

```ts
const user = ref<User>()

// валидируется автоматически — схема из элемента ref'а
user.value = await fetch('/api/me').then(r => r.json())

// инициализатор тоже валидируется
const state = reactive<User>(payload)
```

Покрыты инициализаторы `ref`, `shallowRef`, `reactive` и `shallowReactive`, а
также любое присваивание `someRef.value = …`. Детект **по типу**: срабатывает
только если цель действительно Vue-ref, так что обычный `.value` вроде
`input.value = …` у DOM никогда не трогается.

Работает и в `.ts` / `.tsx` (composables, stores, API-слой), и в `.vue` SFC:
плагин инструментирует блок `<script setup>` (или обычный `<script lang="ts">`).

Не используете Vue? Уберите `'vue'` из опции `boundaries` — и сканирование
полностью отключится:

```ts
// vite.config.ts
t12n({
  mode: 'auto',
  boundaries: ['fetch', 'storage', 'json-parse', 'message-event', 'as-any', 'as-unknown'],
})
```
