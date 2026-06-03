---
layout: ../../../layouts/Doc.astro
title: Ошибки и configure
description: Решите, что происходит при провале проверки — бросать в dev, репортить в проде.
lang: ru
---

# Ошибки и configure

Когда проверка падает, *что должно произойти* — решение, зависящее от стадии,
которое сборка не может принять за вас:

- **dev** — падать громко: бросать, или `console.warn` и ехать дальше.
- **прод** — кривой ответ API должен быть телеметрией, а не белым экраном:
  отправить на бэк и оставить приложение живым.

## Политика — `configure`

Эту политику вы задаёте один раз, на входе в приложение:

```ts
import { configure } from '@dnssfnv/t12n'

configure({
  onViolation: import.meta.env.PROD
    ? ({ error, path }) =>
        navigator.sendBeacon('/t12n', JSON.stringify({ path, msg: error.message }))
    : ({ error }) => console.warn(error.message),
})
```

Один и тот же обработчик срабатывает и на провалах границы, и на live-мутациях,
а контекст их различает:

```ts
interface ViolationContext {
  site: 'boundary' | 'mutation'   // пришло кривым / замутировали не в тип
  path: string                    // 'user.address.zip'
  error: ValidationError          // это же и бросается по умолчанию
  issue: ValidationIssue
  value: unknown                  // нарушившее значение
  schema: Schema                  // с чем сверяли
  source?: string                 // 'src/pages/Profile.vue:42' — если встроено
  boundary?: string               // 'fetch().json()' — если известно
}
```

Правило простое:

- **Нет обработчика** (по умолчанию) → `ValidationError` **бросается**. Fail-fast.
- **Обработчик вернулся нормально** → t12n **не** бросает. Значение на границе
  проходит как есть; мутация применяется. Это путь «репорти, но не падай».
- **Обработчик бросил** → это пробрасывается. Перебросьте `ctx.error`, чтобы
  прервать, сохранив исходное сообщение и стек.

`configure({ onViolation: null })` возвращает поведение «всегда бросать».

## `ValidationError`

`ValidationError` несёт полную картину — её можно отрендерить, залогировать,
проверить в тестах:

```ts
class ValidationError extends Error {
  readonly path: string                 // 'user.address.zip'
  readonly expected: string             // 'string'
  readonly received: unknown            // 12345
  readonly issues: ValidationIssue[]    // ВСЕ битые поля этой границы
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

Ловится обычным `instanceof`:

```ts
import { ValidationError } from '@dnssfnv/t12n'

try {
  doSomething()
} catch (e) {
  if (e instanceof ValidationError) {
    console.warn('некорректные данные:', e.path, '— ожидалось', e.expected)
  }
}
```

Это весь публичный API. `t12n` отдаёт в рантайм всего две вещи:
`ValidationError` — для `instanceof`-проверок в `catch`-блоках, и `configure` —
для разовой настройки политики выше. Никаких `validate()`, никаких
`safeValidate()`, нечего вызывать на каждое значение. Плагин делает вызовы; вы
пишете типы.

## Все битые поля — в одной ошибке

Одна граница бросает **одну** `ValidationError`, но она несёт **все** провалившиеся
поля, а не только первое. Когда payload неправильный сразу в нескольких местах,
вы видите их вместе:

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

`error.issues` — это и есть тот список; `error.path` / `.expected` / `.received`
повторяют первую запись, так что простой код продолжает работать. Валидный путь
не трогается — сбор полного списка происходит только после того, как проверка уже
провалилась, поэтому хорошие данные он не замедляет.

> «Тощие» прод-сборки с `emitSchema: false` не несут схему в рантайме, поэтому
> AOT-граница там сообщит только первое битое поле. В dev и в любой сборке со
> схемой выводятся все.

## Куда указывает ошибка — `errorLocation`

Плагин умеет встраивать **исходную локацию** (`файл:строка`) и **границу**,
откуда пришло значение, — и тогда падение читается так:

```
[t12n] Validation failed · src/pages/Profile.vue:42  (fetch().json())

  user.email
    expected   string
    received   null
```

`source` и `boundary` также попадают в `error.source` / `error.boundary` и в
`ViolationContext` — так что обработчик телеметрии может группировать падения по
источнику.

Управляется опцией `errorLocation` у плагина:

```ts
// vite.config.ts
t12n({ mode: 'auto', errorLocation: 'auto' })
```

| `errorLocation` | Поведение |
| :--- | :--- |
| `'auto'` | **По умолчанию** — встраивать на dev-сервере, опускать в прод-сборке (бандл легче) |
| `true` | Встраивать всегда — удобно, если шлёте падения в телеметрию |
| `false` | Не встраивать никогда |
