---
layout: ../../../layouts/Doc.astro
title: Фреймворки
description: t12n завязан на бандлер, а не на фреймворк — React, Next.js, Vue/Nuxt, Svelte, Solid и любая сборка Vite/webpack/Rollup/esbuild/Rspack.
lang: ru
---

# Фреймворки

t12n **завязан на бандлер, а не на конкретный фреймворк**. Плагин работает через
[unplugin](https://unplugin.unjs.io/), поэтому один и тот же движок встаёт в
Vite, webpack, Rollup, esbuild и Rspack — а вставляемая проверка — это обычный
JavaScript, который работает где угодно (браузер, Node, edge).

## Точки входа под бандлеры

Берите ту, что у вашего инструмента — плагин один и тот же:

| Бандлер | Импорт |
| :--- | :--- |
| Vite | `t12n/vite` |
| webpack | `t12n/webpack` |
| Rollup | `t12n/rollup` |
| esbuild | `t12n/esbuild` |
| Rspack | `t12n/rspack` |

## React

React на Vite **не требует отдельной настройки**. Generic-границы —
`fetch().json()`, `JSON.parse`, `localStorage`, `as any` — работают в `.tsx` из
коробки, и каждый тип так же компилируется в отдельный валидатор.

С границей `react` (включена по умолчанию) t12n дополнительно:

- валидирует инициализаторы `useState<T>(init)` / `useRef<T>(init)` против `T`;
- **пропускает параметры и возвраты компонентов** (PascalCase) и **хуков**
  (`use…`) в auto-режиме — это внутренние, проверяемые компилятором сущности, а
  не границы, поэтому t12n не инструментирует каждый проп. Включить точечно —
  через `Check<T>`.

```tsx
// payload валидируется против User
const [user, setUser] = useState<User>(payload)

// валидируется — настоящая граница
const data: ApiData = await fetch('/api').then(r => r.json())

// НЕ инструментируется — пропсы внутренние, их проверяет компилятор
function Card({ user }: { user: User }) { /* … */ }
```

## Next.js

Next собирается на webpack, поэтому подключайте t12n через `t12n/webpack`:

```js
// next.config.js
import t12n from 't12n/webpack'

export default {
  webpack(config) {
    config.plugins.push(t12n())
    return config
  },
}
```

Рантайм — обычный JS, так что проверки работают и в браузере, и в Node (API
routes, серверные компоненты), и на edge.

> **Turbopack пока не поддерживается.** У него нет API для трансформации
> исходников, а шаг t12n «тип → схема» требует TypeScript-чекер, который внутри
> него не запустить. Пока используйте сборку на webpack (`next build` или
> `next dev` без `--turbo`).

## Vue / Nuxt

Полная поддержка через границу `vue`: инициализаторы `ref` / `shallowRef` /
`reactive`, присваивания `someRef.value = …` и `.vue` SFC (плагин
инструментирует `<script setup>` или обычный `<script lang="ts">`).

## Solid

Граница `solid` валидирует инициализаторы `createSignal<T>(init)` и
`createStore<T>(init)` против `T`:

```tsx
const [user, setUser] = createSignal<User>(payload)  // payload валидируется
```

## Svelte / SvelteKit

Граница `svelte` парсит `.svelte` SFC и валидирует руну `$state(init)` — тип
берётся из `$state<T>(…)` или аннотации `let x: T`:

```svelte
<script lang="ts">
  let user: User = $state(payload)   // payload валидируется против User
</script>
```

## Всё остальное

Плагин для Vite/webpack/Rollup/esbuild/Rspack плюс generic-границы
(fetch / parse / storage / касты) работают в **Astro, Remix и любом TS-проекте**.
А [`Check<T>`](/ru/guide/boundaries#manual-режим--checkt) даёт явную проверку
везде, где TypeScript принимает аннотацию типа.
