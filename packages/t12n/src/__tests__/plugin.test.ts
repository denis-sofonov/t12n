import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import t12n, { type T12nMode, type T12nOptions } from '../vite/index.js'

// ---------------------------------------------------------------------------
// Helper — runs the plugin's transform hook in isolation.
// ---------------------------------------------------------------------------

let dir: string

beforeAll(() => {
  dir = join(tmpdir(), `t12n-plugin-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  writeFileSync(join(dir, 'types.ts'), `
export interface User { id: number; name: string; email?: string }
export interface Result { ok: boolean }
export interface Tree { value: string; children: Tree[] }
`)
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2020', jsx: 'react-jsx' },
    include: ['*.ts', '*.tsx'],
  }))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface MinimalCtx {
  warn(msg: string): void
  addWatchFile(path: string): void
}

async function transformFile(
  code: string,
  mode: T12nMode = 'auto',
  fileName = 'app.ts',
  live = false,
  boundaries?: T12nOptions['boundaries'],
  extra?: Partial<T12nOptions>,
) {
  const filePath = join(dir, fileName)
  writeFileSync(filePath, code)

  // Default live:false so emitted output is the deterministic one-shot
  // `__t12n_check`. Live (Proxy) emission is covered explicitly below.
  const plugin = t12n({ mode, tsconfig: join(dir, 'tsconfig.json'), live, boundaries, ...extra })
  // unplugin Vite plugins expose buildStart/transform/buildEnd hooks.
  const ctx: MinimalCtx = { warn() {}, addWatchFile() {} }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks = plugin as any
  await hooks.buildStart?.call(ctx)

  const include = hooks.transformInclude?.(filePath) ?? true
  if (!include) return null

  // Vite's transform hook can be an object with `handler`, or a function.
  const transform = typeof hooks.transform === 'function'
    ? hooks.transform
    : hooks.transform?.handler
  const result = await transform.call(ctx, code, filePath)
  return result?.code ?? null
}

// ---------------------------------------------------------------------------
// auto mode — current behaviour
// ---------------------------------------------------------------------------

describe('mode: auto', () => {
  it('wraps fetch().json() at typed declaration', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `)
    expect(out).toContain('__t12n_runAot(')
    expect(out).toContain(`{kind:'object'`)
    expect(out).toContain(`"id":{kind:'number'}`)
  })

  it('wraps JSON.parse at typed declaration', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = JSON.parse(localStorage.getItem('u') ?? '{}')
    `)
    expect(out).toContain('__t12n_runAot(')
  })

  it('wraps "as any" cast', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = { id: 1, name: 'A' } as any
    `)
    expect(out).toContain('__t12n_runAot(')
  })

  it('does NOT wrap when type annotation is missing', async () => {
    const out = await transformFile(`
      const u = await fetch('/me').then(r => r.json())
    `)
    expect(out).toBeNull()
  })

  it('does NOT wrap when there is no boundary pattern', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = { id: 1, name: 'A' }
    `)
    expect(out).toBeNull()
  })

  it('wraps function parameter with non-primitive type', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      function greet(u: User) { return u.name }
    `)
    expect(out).toMatch(/u = __t12n_runAot\(__t12n_v\d+, u,/)
  })

  it('wraps function return type', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      function getUser(): User { return { id: 1, name: 'A' } }
    `)
    expect(out).toContain('return __t12n_runAot(')
  })

  it('does NOT wrap return statements of nested functions with outer schema', async () => {
    const out = await transformFile(`
      import type { User, Result } from './types'
      function outer(): User {
        function inner(): Result { return { ok: true } }
        inner()
        return { id: 1, name: 'A' }
      }
    `)
    // outer returns User; inner returns Result. Each return is wrapped with its
    // OWN generated validator/schema (hoisted) — never the other's.
    const lines = out!.split('\n')
    const innerLine = lines.find((l: string) => l.includes('{ ok: true }'))!
    const outerLine = lines.find((l: string) => l.includes("{ id: 1, name: 'A' }"))!
    const sInner = innerLine.match(/__t12n_s(\d+)/)![1]
    const sOuter = outerLine.match(/__t12n_s(\d+)/)![1]
    expect(sInner).not.toBe(sOuter) // distinct schemas, no cross-wiring

    const declOf = (n: string) => lines.find((l: string) => l.includes(`const __t12n_s${n} =`))!
    expect(declOf(sInner)).toContain(`"ok":{kind:'boolean'}`)
    expect(declOf(sInner)).not.toContain(`"id"`)
    expect(declOf(sOuter)).toContain(`"id":{kind:'number'}`)
  })

  it('emits the runtime import only once', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const a: User = await fetch('/a').then(r => r.json())
      const b: User = await fetch('/b').then(r => r.json())
    `)
    const matches = out!.match(/from ['"]t12n\/runtime['"]/g)
    expect(matches?.length).toBe(1)
  })

  it('does NOT emit any zod import (we are zero-dep)', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const a: User = await fetch('/a').then(r => r.json())
      const b: User = await fetch('/b').then(r => r.json())
    `)
    expect(out).not.toContain('from \'zod\'')
    expect(out).not.toContain('from "zod"')
  })
})

// ---------------------------------------------------------------------------
// manual mode — only Check<T> triggers
// ---------------------------------------------------------------------------

describe('mode: manual', () => {
  it('wraps initializer when annotation is Check<T>', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      type Check<T> = T
      const u: Check<User> = await fetch('/me').then(r => r.json())
    `, 'manual')
    expect(out).toContain('__t12n_runAot(')
    expect(out).toContain(`"id":{kind:'number'}`)
  })

  it('does NOT wrap a plain : User annotation', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'manual')
    expect(out).toBeNull()
  })

  it('replaces Check<User> annotation with User in emitted code', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      type Check<T> = T
      const u: Check<User> = await fetch('/me').then(r => r.json())
    `, 'manual')
    expect(out).toContain('const u: User =')
    expect(out).not.toContain('Check<User>')
  })

  it('wraps Check<T> in function parameters', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      type Check<T> = T
      function greet(u: Check<User>) { return u.name }
    `, 'manual')
    expect(out).toMatch(/u = __t12n_runAot\(__t12n_v\d+, u,/)
    expect(out).toContain('greet(u: User)')
  })

  it('wraps Check<T> as return type', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      type Check<T> = T
      function getUser(): Check<User> { return { id: 1, name: 'A' } as any }
    `, 'manual')
    expect(out).toContain('return __t12n_runAot(')
    expect(out).toContain('getUser(): User')
  })
})

// ---------------------------------------------------------------------------
// off mode
// ---------------------------------------------------------------------------

describe('mode: off', () => {
  it('returns null for everything', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'off')
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Boundary detection precision
// ---------------------------------------------------------------------------

describe('boundary detection', () => {
  it('does NOT match .data on a non-MessageEvent receiver', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const response = { data: { id: 1, name: 'A' } }
      const u: User = response.data
    `)
    // response is a plain object — not MessageEvent — so .data shouldn't trip the plugin.
    expect(out).toBeNull()
  })

  it('does match .data on a MessageEvent receiver', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const ev = {} as MessageEvent<unknown>
      const u: User = ev.data
    `)
    expect(out).toContain('__t12n_runAot(')
  })
})

describe('live mode', () => {
  it('emits __t12n_guard (not __check) when live:true', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'auto', 'app.ts', true)
    expect(out).toContain("import { __guard as __t12n_guard } from 't12n/runtime'")
    expect(out).toContain('__t12n_guard(')
    expect(out).not.toContain('__t12n_check(')
  })

  it('emits AOT validators (not __guard) when live:false', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'auto', 'app.ts', false)
    expect(out).toContain('__runAot as __t12n_runAot')
    expect(out).toContain('__t12n_runAot(')
    expect(out).not.toContain('__t12n_guard(')
  })
})

// ---------------------------------------------------------------------------
// AOT codegen (production / live:false)
// ---------------------------------------------------------------------------

describe('AOT codegen', () => {
  it('hoists a generated validator + schema const for a boundary', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `)
    // schema const (data) + validator const (specialized function)
    expect(out).toMatch(/const __t12n_s0 = \{kind:'object'/)
    expect(out).toMatch(/const __t12n_v0 = \(v\) =>/)
    // generated body uses static property access (v.id), not dynamic value[key]
    expect(out).toContain('= v.id')
    expect(out).toContain('= v.name')
  })

  it('dedupes one validator across repeated identical schemas', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const a: User = await fetch('/a').then(r => r.json())
      const b: User = await fetch('/b').then(r => r.json())
    `)
    // exactly one validator const, reused at both boundaries
    expect(out!.match(/const __t12n_v\d+ =/g)!.length).toBe(1)
    expect(out!.match(/__t12n_runAot\(__t12n_v0,/g)!.length).toBe(2)
  })

  it('falls back to __check for recursive (def/ref) schemas', async () => {
    const out = await transformFile(`
      import type { Tree } from './types'
      const t: Tree = JSON.parse(localStorage.getItem('t') ?? '{}')
    `)
    expect(out).toContain('__t12n_check(')
    expect(out).not.toContain('__t12n_runAot(')
    expect(out).toContain(`kind:'def'`)
  })
})

describe('vue reactivity detection', () => {
  // Mirrors Vue's Ref shape + factories without installing vue.
  const PREAMBLE = `
    import type { User } from './types'
    interface Ref<T> { value: T }
    declare function ref<T>(v?: T): Ref<T>
    declare function reactive<T>(t: T): T
    declare const payload: any
  `

  it('wraps the init arg of ref<User>(payload)', async () => {
    const out = await transformFile(`${PREAMBLE}
      const user = ref<User>(payload)
    `)
    expect(out).toMatch(/__t12n_runAot\(__t12n_v\d+, payload,/)
  })

  it('wraps a someRef.value = payload assignment', async () => {
    const out = await transformFile(`${PREAMBLE}
      const user = ref<User>()
      user.value = payload
    `)
    expect(out).toMatch(/user\.value = __t12n_runAot\(__t12n_v\d+, payload,/)
  })

  it('wraps reactive<User>(payload)', async () => {
    const out = await transformFile(`${PREAMBLE}
      const state = reactive<User>(payload)
    `)
    expect(out).toMatch(/__t12n_runAot\(__t12n_v\d+, payload,/)
  })

  it('does NOT wrap a non-Vue .value assignment (DOM element)', async () => {
    const out = await transformFile(`
      const el = {} as HTMLInputElement
      el.value = 'hello'
    `)
    expect(out).toBeNull()
  })

  it('does NOT wrap ref(payload) whose value type is any', async () => {
    const out = await transformFile(`${PREAMBLE}
      const loose = ref(payload)
    `)
    expect(out).toBeNull()
  })

  it('is disabled when vue is excluded from boundaries', async () => {
    const out = await transformFile(`${PREAMBLE}
      const user = ref<User>(payload)
    `, 'auto', 'app.ts', false, ['fetch'])
    expect(out).toBeNull()
  })
})

describe('vue SFC (.vue)', () => {
  it('instruments a boundary inside <script setup>', async () => {
    const out = await transformFile(`<script setup lang="ts">
import type { User } from './types'
const user: User = await fetch('/me').then(r => r.json())
</script>

<template><div>{{ user.name }}</div></template>
`, 'auto', 'App.vue')
    expect(out).not.toBeNull()
    expect(out).toContain('__runAot as __t12n_runAot')
    expect(out).toContain('__t12n_runAot(')
    // the validator + import live inside the <script>, not before the SFC
    expect(out!.indexOf('__t12n_runAot')).toBeGreaterThan(out!.indexOf('<script'))
    expect(out!.indexOf('__t12n_check')).toBeLessThan(out!.indexOf('</script>'))
    // template is left untouched
    expect(out).toContain('<template><div>{{ user.name }}</div></template>')
  })

  it('detects a vue ref boundary inside an SFC', async () => {
    const out = await transformFile(`<script setup lang="ts">
import type { User } from './types'
interface Ref<T> { value: T }
declare function ref<T>(v?: T): Ref<T>
declare const payload: any
const user = ref<User>()
user.value = payload
</script>
`, 'auto', 'App2.vue')
    expect(out).toMatch(/user\.value = __t12n_runAot\(__t12n_v\d+, payload,/)
  })

  it('returns null for a .vue with no script', async () => {
    const out = await transformFile(`<template><div /></template>`, 'auto', 'Empty.vue')
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// React (.tsx) — useState boundary + component/hook skipping
// ---------------------------------------------------------------------------

describe('react detection', () => {
  it('wraps a useState<User>(init) initialiser', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      import { useState } from 'react'
      export function View(payload: User) {
        const [u] = useState<User>(payload)
        return u
      }
    `, 'auto', 'View.tsx')
    expect(out).toMatch(/__t12n_runAot\(__t12n_v\d+, payload,/)
  })

  it('does NOT instrument a component (PascalCase) param', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      export function Card({ user }: { user: User }) { return user }
    `, 'auto', 'Card.tsx')
    // no boundary at all here → nothing emitted
    expect(out).toBeNull()
  })

  it('does NOT instrument a hook (use*) param/return', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      export function useUser(seed: User): User { return seed }
    `, 'auto', 'useUser.tsx')
    expect(out).toBeNull()
  })

  it('still instruments a plain function in a .tsx file', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      export function processUser(u: User): User { return u }
    `, 'auto', 'work.tsx')
    expect(out).toMatch(/u = __t12n_runAot\(__t12n_v\d+, u,/)
    expect(out).toContain('return __t12n_runAot(')
  })

  it('honours Check<T> on a component param despite react skipping', async () => {
    const out = await transformFile(`
      type Check<T> = T
      import type { User } from './types'
      export function Card(user: Check<User>) { return user }
    `, 'auto', 'Card2.tsx')
    expect(out).toMatch(/user = __t12n_runAot\(__t12n_v\d+, user,/)
  })
})

// ---------------------------------------------------------------------------
// errorLocation — embed source location + boundary kind
// ---------------------------------------------------------------------------

describe('errorLocation', () => {
  it('embeds {at,b} when errorLocation:true', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'auto', 'loc.ts', false, undefined, { errorLocation: true })
    expect(out).toMatch(/\{at:"[^"]*loc\.ts:\d+",b:"fetch\(\)\.json\(\)"\}/)
  })

  it('labels a param boundary', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      function work(user: User) { return user.name }
    `, 'auto', 'loc2.ts', false, undefined, { errorLocation: true })
    expect(out).toContain('b:"param \\"user\\""')
  })

  it('omits location when errorLocation:false', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'auto', 'loc3.ts', false, undefined, { errorLocation: false })
    expect(out).not.toContain('{at:')
  })
})

// ---------------------------------------------------------------------------
// Solid & Svelte
// ---------------------------------------------------------------------------

describe('solid detection', () => {
  it('wraps createSignal<User>(init)', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      import { createSignal } from 'solid-js'
      export function App(payload: User) {
        const [u] = createSignal<User>(payload)
        return u
      }
    `, 'auto', 'Solid.tsx')
    expect(out).toMatch(/__t12n_runAot\(__t12n_v\d+, payload,/)
  })
})

describe('svelte detection', () => {
  it('parses a .svelte SFC and wraps $state(init)', async () => {
    const out = await transformFile(`<script lang="ts">
  import type { User } from './types'
  export let payload: User
  let user: User = $state(payload)
</script>

<div>{user.name}</div>
`, 'auto', 'Counter.svelte')
    expect(out).not.toBeNull()
    expect(out).toMatch(/__t12n_runAot\(__t12n_v\d+, payload,/)
    // injected inside the <script>, not before the SFC
    expect(out!.indexOf('__t12n_runAot')).toBeGreaterThan(out!.indexOf('<script'))
  })

  it('returns null for a .svelte with no instance script', async () => {
    const out = await transformFile(`<div>static</div>`, 'auto', 'Static.svelte')
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// emitSchema — drop the per-boundary schema literal in production
// ---------------------------------------------------------------------------

describe('emitSchema', () => {
  it('drops the schema const when emitSchema:false', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'auto', 'es1.ts', false, undefined, { emitSchema: false, errorLocation: false })
    expect(out).not.toMatch(/__t12n_s\d+ =/)
    expect(out).toMatch(/__t12n_runAot\(__t12n_v\d+, [^,)]+\)/)
  })

  it('keeps the schema const when emitSchema:true', async () => {
    const out = await transformFile(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'auto', 'es2.ts', false, undefined, { emitSchema: true, errorLocation: false })
    expect(out).toMatch(/const __t12n_s\d+ =/)
    expect(out).toMatch(/__t12n_runAot\(__t12n_v\d+, .+, __t12n_s\d+\)/)
  })
})

// ---------------------------------------------------------------------------
// onUnvalidated — boundaries whose type validates nothing (any/unknown)
// ---------------------------------------------------------------------------

describe('onUnvalidated', () => {
  // Local harness: capture warnings and run buildEnd (the shared transformFile
  // swallows warns and never calls buildEnd).
  async function runWithWarns(code: string, fileName: string, extra?: Partial<T12nOptions>) {
    const filePath = join(dir, fileName)
    writeFileSync(filePath, code)
    const warns: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = t12n({ mode: 'auto', tsconfig: join(dir, 'tsconfig.json'), live: false, ...extra }) as any
    const ctx = { warn: (m: string) => warns.push(m), addWatchFile() {} }
    await plugin.buildStart?.call(ctx)
    const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler
    const res = await transform.call(ctx, code, filePath)
    let buildErr: Error | null = null
    try { await plugin.buildEnd?.call(ctx) } catch (e) { buildErr = e as Error }
    return { code: (res?.code ?? '') as string, warns, buildErr }
  }

  const noopBoundary = `
    type Anything = any
    const u: Anything = await fetch('/me').then(r => r.json())
  `

  it('skips and warns when a boundary type validates nothing (default)', async () => {
    const { code, warns } = await runWithWarns(noopBoundary, 'noop1.ts')
    expect(code).not.toContain('__t12n_')               // no useless no-op check emitted
    expect(warns.some(w => /can't validate/.test(w))).toBe(true)
    expect(warns.some(w => /noop1\.ts:\d+/.test(w))).toBe(true)
  })

  it("onUnvalidated:'error' fails the build", async () => {
    const { buildErr } = await runWithWarns(noopBoundary, 'noop2.ts', { onUnvalidated: 'error' })
    expect(buildErr).toBeInstanceOf(Error)
    expect(buildErr?.message).toMatch(/validates nothing|any\/unknown/)
  })

  it("onUnvalidated:'off' stays silent", async () => {
    const { code, warns, buildErr } = await runWithWarns(noopBoundary, 'noop3.ts', { onUnvalidated: 'off' })
    expect(warns).toHaveLength(0)
    expect(buildErr).toBeNull()
    expect(code).not.toContain('__t12n_')
  })

  it('still wraps a normal, validatable boundary', async () => {
    const { code, warns } = await runWithWarns(`
      import type { User } from './types'
      const u: User = await fetch('/me').then(r => r.json())
    `, 'ok1.ts')
    expect(code).toContain('__t12n_')
    expect(warns).toHaveLength(0)
  })
})
