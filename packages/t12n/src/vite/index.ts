import { relative, sep } from 'node:path'
import { createUnplugin } from 'unplugin'
import { Project, SyntaxKind, Node, type TypeNode, type Type } from 'ts-morph'
import MagicString from 'magic-string'
import type { Plugin } from 'vite'
import { typeNodeToSchema, typeToSchemaString } from './schema-gen.js'
import { generate } from './codegen.js'

/** Which sites the plugin will instrument. */
export type T12nMode =
  /** Default. Scans typed boundary patterns (fetch/storage/postMessage/as any), typed function params and return types. */
  | 'auto'
  /** Only sites tagged with `Check<T>` get instrumented. Nothing else. */
  | 'manual'
  /** Off — the plugin is a no-op (compile-time `t12n` type overrides still apply). */
  | 'off'

export interface T12nOptions {
  /** Default: 'auto'. */
  mode?: T12nMode
  /** Path to tsconfig.json for ts-morph. Default: './tsconfig.json'. */
  tsconfig?: string
  /**
   * Override which boundaries trigger auto-detection. Default: all.
   *
   * `vue` recognises Vue/Nuxt reactivity sites — `ref`/`shallowRef`/`reactive`
   * initialisers and `someRef.value = …` assignments — deriving the schema from
   * the ref's element type. It is type-driven, so it never fires on a non-Vue
   * `.value` (e.g. a DOM element's).
   *
   * `react` recognises `useState<T>(init)` initialisers, and — crucially — makes
   * auto-mode skip the parameters/returns of React components (PascalCase) and
   * hooks (`use…`) in `.tsx`, so it doesn't instrument every prop. Generic
   * boundaries (fetch/parse/storage/casts) still apply.
   *
   * `solid` recognises Solid's `createSignal<T>(init)` / `createStore<T>(init)`.
   * `svelte` parses `.svelte` SFCs and recognises the `$state(init)` rune
   * (type from `$state<T>` or the `let x: T` annotation).
   */
  boundaries?: ReadonlyArray<'fetch' | 'storage' | 'json-parse' | 'message-event' | 'as-any' | 'as-unknown' | 'vue' | 'react' | 'solid' | 'svelte'>
  /**
   * Emit the live Proxy guard (`__guard`) instead of the one-shot validator
   * (`__check`). The guard keeps enforcing the type for the value's whole
   * lifetime — off-type mutations are caught too — at the cost of trapping
   * every property access.
   *
   * Default: `true` on the dev server (Vite `serve`), `false` for production
   * builds. Set explicitly to force it on/off for every stage. What *happens*
   * on a violation (throw / log / ship to backend) is configured separately at
   * runtime via `configure({ onViolation })`.
   */
  live?: boolean
  /**
   * Embed the source location (`file:line`) and boundary kind into each check,
   * so a `ValidationError` points back at the exact site in your source.
   *
   * - `'auto'` (default): on for the dev server, off for production builds
   *   (keeps the prod bundle lean).
   * - `true`: always embed — useful if you ship boundary failures to telemetry.
   * - `false`: never embed.
   */
  errorLocation?: 'auto' | boolean
  /**
   * Emit the schema literal next to each AOT validator. It's only used to fill
   * `ViolationContext.schema` on the cold failure path — so dropping it shaves
   * bytes off every boundary in the app bundle.
   *
   * - `'auto'` (default): keep it on the dev server, drop it in production.
   * - `true` / `false`: force on / off. Recursive types and the live guard
   *   always carry their schema regardless (they need it to validate).
   */
  emitSchema?: 'auto' | boolean
  /**
   * What to do when a boundary's type resolves to a schema that validates
   * *nothing* — `any`, `unknown`, or a type t12n can't model yet. These are
   * silent holes: the site looks guarded but lets anything through, so it's the
   * one place t12n could quietly let bad data past. Rather than emit a useless
   * no-op check, the plugin skips the site and reports it.
   *
   * - `'warn'` (default): log each unvalidated boundary during the build.
   * - `'error'`: fail the build — use in CI to forbid unvalidated boundaries.
   * - `'off'`: skip silently.
   */
  onUnvalidated?: 'warn' | 'error' | 'off'
}

const RUNTIME_IMPORT = '@dnssfnv/t12n/runtime'
const CHECK_FN       = '__t12n_check'
const GUARD_FN       = '__t12n_guard'
// AOT helpers. FAIL_SENTINEL / AOTFAIL_FN must match the names codegen.ts emits.
const RUNAOT_FN      = '__t12n_runAot'
const AOTFAIL_FN     = '__t12n_fail'
const FAIL_SENTINEL  = '__t12n_FAIL'

// A type that resolves to `unknown`/`any` produces one of these exact literals;
// validating against either is a no-op, so we skip wrapping those sites (and,
// per `onUnvalidated`, report them — a wrapped no-op is a silent hole).
const UNKNOWN_SCHEMA = `{kind:'unknown'}`
const ANY_SCHEMA = `{kind:'any'}`
const isNoopSchema = (s: string) => s === UNKNOWN_SCHEMA || s === ANY_SCHEMA

const PRIMITIVE_KINDS = new Set([
  SyntaxKind.StringKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.AnyKeyword,
  SyntaxKind.UnknownKeyword,
  SyntaxKind.NeverKeyword,
])

const FN_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
])

function nearestFunctionLike(node: Node): Node | undefined {
  let cur = node.getParent()
  while (cur) {
    if (FN_KINDS.has(cur.getKind())) return cur
    cur = cur.getParent()
  }
  return undefined
}

/**
 * Returns true if `typeNode` is a `Check<T>` reference. Compared by the local
 * name only — the user is expected to import the type from '@dnssfnv/t12n' (or have it
 * via ambient types). We do not chase aliases.
 */
function isCheckAnnotation(typeNode: TypeNode): TypeNode | null {
  if (!Node.isTypeReference(typeNode)) return null
  const name = typeNode.getTypeName().getText()
  if (name !== 'Check') return null
  const args = typeNode.getTypeArguments()
  return args[0] ?? null
}

/**
 * Is `receiverType` something that looks like a DOM `MessageEvent`-ish
 * receiver? We check the type's apparent name + property set, not the
 * receiver expression text — so `response.data` from an HTTP client does
 * not get treated as a boundary.
 */
function isMessageEventLike(receiverType: Type | undefined): boolean {
  if (!receiverType) return false
  const text = receiverType.getText()
  return /\bMessageEvent\b/.test(text)
}

/**
 * If `init` matches a boundary pattern, return a human label for it
 * (`fetch().json()`, `JSON.parse()`, …) — used both to decide whether to wrap
 * and to attach a boundary hint to the error. Returns `null` for no match.
 */
function boundaryKind(
  init: Node,
  enabled: { fetch: boolean; storage: boolean; jsonParse: boolean; messageEvent: boolean; asAny: boolean; asUnknown: boolean },
): string | null {
  const checkCall = (node: Node): string | null => {
    if (!Node.isCallExpression(node)) return null
    const callee = node.getExpression()
    if (!Node.isPropertyAccessExpression(callee)) return null
    const method = callee.getName()
    if (enabled.fetch && (method === 'json' || method === 'text' || method === 'formData')) return `fetch().${method}()`
    if (enabled.storage && method === 'getItem') return 'storage.getItem()'
    if (enabled.jsonParse && method === 'parse') {
      const obj = callee.getExpression()
      if (Node.isIdentifier(obj) && obj.getText() === 'JSON') return 'JSON.parse()'
    }
    return null
  }

  let hit = checkCall(init)
  if (hit) return hit
  for (const call of init.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if ((hit = checkCall(call))) return hit
  }

  const checkAssertion = (node: Node): string | null => {
    if (!Node.isAsExpression(node)) return null
    const kind = node.getTypeNode()?.getKind()
    if (kind === SyntaxKind.AnyKeyword)     return enabled.asAny ? 'as any' : null
    if (kind === SyntaxKind.UnknownKeyword) return enabled.asUnknown ? 'as unknown' : null
    return null
  }
  if ((hit = checkAssertion(init))) return hit
  for (const a of init.getDescendantsOfKind(SyntaxKind.AsExpression)) {
    if ((hit = checkAssertion(a))) return hit
  }

  if (enabled.messageEvent) {
    const checkData = (node: Node): boolean => {
      if (!Node.isPropertyAccessExpression(node)) return false
      if (node.getName() !== 'data') return false
      return isMessageEventLike(node.getExpression().getType())
    }
    if (checkData(init)) return 'event.data'
    for (const p of init.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (checkData(p)) return 'event.data'
    }
  }

  return null
}

// Vue/Nuxt reactivity factories whose value is the first argument.
const REF_VALUE_FACTORIES = new Set(['ref', 'shallowRef'])
// Factories that return the reactive object itself (T is the return type).
const REACTIVE_FACTORIES = new Set(['reactive', 'shallowReactive'])
// Symbol names of writable ref containers: Ref, ShallowRef, WritableComputedRef…
const REF_TYPE_NAME = /Ref$/

/** The element type of a Ref-like (`{ value: T }`) container, resolved at `at`. */
function refValueType(refType: Type, at: Node): Type | undefined {
  return refType.getProperty('value')?.getTypeAtLocation(at)
}

/**
 * Pull the analysable TS out of a `.vue` SFC. Prefers `<script setup>`, falls
 * back to a plain `<script>`. Returns the script body plus its byte offset in
 * the original file, so emitted ops can be mapped back onto the full source.
 */
function extractVueScript(code: string): { content: string; start: number } | null {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  let first: { content: string; start: number } | null = null
  while ((m = re.exec(code))) {
    const attrs = m[1]
    const start = m.index + m[0].indexOf('>') + 1
    const seg = { content: m[2], start }
    if (/\bsetup\b/.test(attrs)) return seg // <script setup> wins
    if (!first) first = seg
  }
  return first
}

/**
 * Pull the instance `<script>` out of a Svelte SFC — skipping the module script
 * (`<script module>` / `<script context="module">`). Returns the body + offset.
 */
function extractSvelteScript(code: string): { content: string; start: number } | null {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    if (/\bmodule\b|context\s*=\s*["']module["']/.test(m[1])) continue
    return { content: m[2], start: m.index + m[0].indexOf('>') + 1 }
  }
  return null
}

// Solid state factories whose value type is the first type argument.
const SOLID_STATE_FACTORIES = new Set(['createSignal', 'createStore'])

/** True for a Vue ref container — name ends in `Ref` and it carries `.value`. */
function isRefLike(type: Type): boolean {
  const name = (type.getSymbol() ?? type.getAliasSymbol())?.getName()
  return !!name && REF_TYPE_NAME.test(name) && type.getProperty('value') != null
}

// React state factories whose state type is the first type argument:
// `useState<T>(init)`, `useRef<T>(init)`.
const REACT_STATE_FACTORIES = new Set(['useState', 'useRef'])

/**
 * Best-effort name of a function-like node — declaration name, or the variable /
 * property it's assigned to (for arrow components/hooks).
 */
function functionLikeName(fn: Node): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const named = (fn as any).getName?.()
  if (named) return named
  const parent = fn.getParent()
  if (parent && (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent))) {
    return parent.getNameNode().getText()
  }
  return ''
}

/**
 * A React component (PascalCase) or hook (`use…`). Auto-mode skips their
 * params/returns so it doesn't validate every prop — those are compiler-checked
 * internals, not boundaries. Explicit `Check<T>` still works.
 */
function isReactComponentOrHook(name: string): boolean {
  return /^[A-Z]/.test(name) || /^use[A-Z0-9]/.test(name)
}

const unplugin = createUnplugin((options: T12nOptions = {}) => {
  const mode     = options.mode ?? 'auto'
  const tsconfig = options.tsconfig ?? './tsconfig.json'

  const boundarySet = new Set(options.boundaries ?? ['fetch', 'storage', 'json-parse', 'message-event', 'as-any', 'as-unknown', 'vue', 'react', 'solid', 'svelte'])
  const enabled = {
    fetch:        boundarySet.has('fetch'),
    storage:      boundarySet.has('storage'),
    jsonParse:    boundarySet.has('json-parse'),
    messageEvent: boundarySet.has('message-event'),
    asAny:        boundarySet.has('as-any'),
    asUnknown:    boundarySet.has('as-unknown'),
    vue:          boundarySet.has('vue'),
    react:        boundarySet.has('react'),
    solid:        boundarySet.has('solid'),
    svelte:       boundarySet.has('svelte'),
  }

  const onUnvalidated = options.onUnvalidated ?? 'warn'

  let project: Project | undefined
  let schemaCache: Map<string, string>
  let transformCount = 0
  let boundaryCount = 0
  // Boundaries whose type couldn't be validated (any/unknown/unmodelable) —
  // accumulated across files for the `onUnvalidated: 'error'` build gate.
  let unvalidatedSites: string[] = []

  // Whether to emit the live Proxy guard. Defaults to dev-server only; the
  // Vite `configResolved` hook below refines this. For non-Vite bundlers we
  // fall back to NODE_ENV. An explicit `options.live` always wins.
  let useGuard = options.live ?? (process.env.NODE_ENV !== 'production')
  // Dev vs prod — drives the `errorLocation: 'auto'` default.
  let isDev = process.env.NODE_ENV !== 'production'

  return {
    name: 't12n',
    enforce: 'pre' as const,

    vite: {
      configResolved(config: { command: string }) {
        isDev = config.command === 'serve'
        if (options.live === undefined) useGuard = config.command === 'serve'
      },
    },

    buildStart() {
      if (mode === 'off') return
      try {
        project = new Project({ tsConfigFilePath: tsconfig })
        schemaCache = new Map()
        transformCount = 0
        boundaryCount = 0
        unvalidatedSites = []
      } catch (e) {
        console.warn('[t12n] Failed to init ts-morph project:', e)
      }
    },

    transformInclude(id) {
      if (mode === 'off') return false
      // Strip Vite's query suffix (e.g. Foo.vue?vue&type=script) before matching.
      const clean = id.replace(/\?.*$/, '')
      return /\.(ts|tsx|vue|svelte)$/.test(clean) && !id.includes('node_modules')
    },

    transform(code, id) {
      if (mode === 'off' || !project) return null

      try {
        // For .vue SFCs we analyse only the <script> body, then map emitted
        // edits back onto the full file via `baseOffset`. A virtual `.ts` id
        // (same dir) keeps relative imports resolvable.
        const cleanId  = id.replace(/\?.*$/, '')
        const isVue    = /\.vue$/.test(cleanId)
        const isSvelte = /\.svelte$/.test(cleanId)
        const isTsx    = /\.tsx$/.test(cleanId)
        let analyzeCode = code
        let baseOffset = 0
        let sourceId = id
        if (isVue || isSvelte) {
          const seg = (isVue ? extractVueScript : extractSvelteScript)(code)
          if (!seg) return null
          analyzeCode = seg.content
          baseOffset = seg.start
          sourceId = cleanId + '.ts'
        }

        let source = project.getSourceFile(sourceId)
        if (source) source.replaceWithText(analyzeCode)
        else        source = project.createSourceFile(sourceId, analyzeCode, { overwrite: true })

        type Op =
          | { kind: 'wrap'; initStart: number; initEnd: number; schema: string; boundary?: string }
          | { kind: 'removeType'; colonStart: number; typeEnd: number }
          | { kind: 'replaceType'; typeStart: number; typeEnd: number; text: string }
          | { kind: 'insert'; pos: number; text: string }
          // Function-param validation, assembled at emit time so it can route
          // through the same check/guard/AOT decision as every other boundary.
          | { kind: 'paramValidate'; pos: number; params: { name: string; schema: string; boundary?: string }[] }

        const ops: Op[] = []
        const watchedFiles = new Set<string>()
        const guardedDecls = new Map<number, string>()

        // Source-location helpers (also used by the error-meta embedding below).
        const relFile = relative(process.cwd(), id.replace(/\?.*$/, '')).split(sep).join('/')
        const lineAt = (absOffset: number): number => {
          let line = 1
          const end = Math.min(absOffset, code.length)
          for (let i = 0; i < end; i++) if (code.charCodeAt(i) === 10) line++
          return line
        }

        // A boundary t12n can't actually validate (any/unknown/unmodelable type).
        // We skip the useless no-op wrap and surface it per `onUnvalidated`.
        const reportUnvalidated = (analyzeOffset: number, boundary?: string) => {
          if (onUnvalidated === 'off') return
          const at = `${relFile}:${lineAt(analyzeOffset + baseOffset)}`
          unvalidatedSites.push(at)
          this.warn(`[t12n] ${at} — ${boundary ?? 'boundary'} has a type t12n can't validate (any/unknown); left unchecked. Tighten the type or annotate Check<T>.`)
        }

        // ── 1. Variable declarations ──────────────────────────────────────
        const decls = source.getDescendantsOfKind(SyntaxKind.VariableDeclaration)

        for (const decl of decls) {
          const typeNode = decl.getTypeNode()
          if (!typeNode) continue
          const init = decl.getInitializer()
          if (!init) continue

          // Manual mode → only Check<T>. Auto mode → Check<T> OR boundary heuristics.
          const checkInner = isCheckAnnotation(typeNode)
          let effectiveTypeNode: TypeNode | null = null
          let boundary: string | undefined

          if (checkInner) {
            effectiveTypeNode = checkInner
            boundary = 'Check<T>'
          } else if (mode === 'auto') {
            if (PRIMITIVE_KINDS.has(typeNode.getKind())) continue
            const bk = boundaryKind(init, enabled)
            if (!bk) continue
            effectiveTypeNode = typeNode
            boundary = bk
          } else {
            continue
          }

          const schema = typeNodeToSchema(effectiveTypeNode, schemaCache, watchedFiles)
          if (isNoopSchema(schema)) { reportUnvalidated(init.getStart(), boundary); continue }
          guardedDecls.set(decl.getStart(), schema)

          ops.push({ kind: 'wrap', initStart: init.getStart(), initEnd: init.getEnd(), schema, boundary })

          if (checkInner) {
            // Replace Check<User> → User so the emitted JS keeps the right
            // type if some downstream consumer still uses it.
            ops.push({
              kind: 'replaceType',
              typeStart: typeNode.getStart(),
              typeEnd:   typeNode.getEnd(),
              text:      effectiveTypeNode.getText(),
            })
          } else {
            // Auto-mode: drop the annotation so TS doesn't trip on the
            // synthesised expression (mostly cosmetic — would compile either way).
            const typeStart  = typeNode.getStart()
            const colonStart = analyzeCode.lastIndexOf(':', typeStart)
            ops.push({ kind: 'removeType', colonStart, typeEnd: typeNode.getEnd() })
          }
        }

        // ── 2. Reassignments of guarded variables ─────────────────────────
        if (guardedDecls.size > 0) {
          for (const expr of source.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
            if (expr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue
            const sym = expr.getLeft().getSymbol()
            if (!sym) continue
            const declNode = sym.getValueDeclaration() ?? sym.getDeclarations()[0]
            if (!declNode) continue
            const schema = guardedDecls.get(declNode.getStart())
            if (!schema) continue
            const right = expr.getRight()
            ops.push({ kind: 'wrap', initStart: right.getStart(), initEnd: right.getEnd(), schema, boundary: 'assignment' })
          }
        }

        // ── 2b. Vue/Nuxt reactivity boundaries (auto mode) ────────────────
        // Type-driven, so it never fires on a non-Vue `.value` (e.g. a DOM
        // element). Initialisers: ref/shallowRef(init) and reactive(init).
        // Assignments: `someRef.value = rhs`.
        if (mode === 'auto' && enabled.vue) {
          const skip = (schema: string) => schema === UNKNOWN_SCHEMA || schema === `{kind:'any'}`

          for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const callee = call.getExpression()
            if (!Node.isIdentifier(callee)) continue
            const name = callee.getText()

            let valueType: Type | undefined
            if (REF_VALUE_FACTORIES.has(name))      valueType = refValueType(call.getType(), call)
            else if (REACTIVE_FACTORIES.has(name))  valueType = call.getType()
            else continue

            const arg = call.getArguments()[0]
            if (!valueType || !arg) continue

            const schema = typeToSchemaString(valueType, schemaCache, watchedFiles)
            if (skip(schema)) continue
            ops.push({ kind: 'wrap', initStart: arg.getStart(), initEnd: arg.getEnd(), schema, boundary: `${name}()` })
          }

          for (const expr of source.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
            if (expr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue
            const left = expr.getLeft()
            if (!Node.isPropertyAccessExpression(left) || left.getName() !== 'value') continue

            const objType = left.getExpression().getType()
            if (!isRefLike(objType)) continue

            const valueType = refValueType(objType, left)
            if (!valueType) continue

            const schema = typeToSchemaString(valueType, schemaCache, watchedFiles)
            if (skip(schema)) continue
            const right = expr.getRight()
            ops.push({ kind: 'wrap', initStart: right.getStart(), initEnd: right.getEnd(), schema, boundary: `${left.getExpression().getText()}.value` })
          }
        }

        // ── 2c. React state initialisers (auto mode) ──────────────────────
        // `useState<T>(init)` / `useRef<T>(init)` — the state type is the first
        // type argument; validate the initial value against it.
        if (mode === 'auto' && enabled.react) {
          for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const callee = call.getExpression()
            const name = Node.isIdentifier(callee)
              ? callee.getText()
              : Node.isPropertyAccessExpression(callee) ? callee.getName() : ''
            if (!REACT_STATE_FACTORIES.has(name)) continue

            const typeArg = call.getTypeArguments()[0]
            const arg = call.getArguments()[0]
            if (!typeArg || !arg) continue
            if (PRIMITIVE_KINDS.has(typeArg.getKind())) continue

            const schema = typeNodeToSchema(typeArg, schemaCache, watchedFiles)
            if (schema === UNKNOWN_SCHEMA || schema === `{kind:'any'}`) continue
            ops.push({ kind: 'wrap', initStart: arg.getStart(), initEnd: arg.getEnd(), schema, boundary: `${name}()` })
          }
        }

        // ── 2d. Solid state initialisers (auto mode) ──────────────────────
        // `createSignal<T>(init)` / `createStore<T>(init)`.
        if (mode === 'auto' && enabled.solid) {
          for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const callee = call.getExpression()
            if (!Node.isIdentifier(callee) || !SOLID_STATE_FACTORIES.has(callee.getText())) continue

            const typeArg = call.getTypeArguments()[0]
            const arg = call.getArguments()[0]
            if (!typeArg || !arg) continue
            if (PRIMITIVE_KINDS.has(typeArg.getKind())) continue

            const schema = typeNodeToSchema(typeArg, schemaCache, watchedFiles)
            if (schema === UNKNOWN_SCHEMA || schema === `{kind:'any'}`) continue
            ops.push({ kind: 'wrap', initStart: arg.getStart(), initEnd: arg.getEnd(), schema, boundary: `${callee.getText()}()` })
          }
        }

        // ── 2e. Svelte `$state(init)` rune (auto mode) ────────────────────
        // Type from `$state<T>(…)` or the `let x: T = $state(…)` annotation.
        if (mode === 'auto' && enabled.svelte) {
          for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const callee = call.getExpression()
            const isRune =
              (Node.isIdentifier(callee) && callee.getText() === '$state') ||
              (Node.isPropertyAccessExpression(callee) && callee.getName() === 'raw' && callee.getExpression().getText() === '$state')
            if (!isRune) continue

            const arg = call.getArguments()[0]
            if (!arg) continue
            const typeArg = call.getTypeArguments()[0]
            const typeNode = typeArg ?? call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getTypeNode()
            if (!typeNode || PRIMITIVE_KINDS.has(typeNode.getKind())) continue

            const schema = typeNodeToSchema(typeNode, schemaCache, watchedFiles)
            if (schema === UNKNOWN_SCHEMA || schema === `{kind:'any'}`) continue
            ops.push({ kind: 'wrap', initStart: arg.getStart(), initEnd: arg.getEnd(), schema, boundary: '$state()' })
          }
        }

        // ── 3 & 4. Function parameters and return types ───────────────────
        const fnNodes = [
          ...source.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
          ...source.getDescendantsOfKind(SyntaxKind.FunctionExpression),
          ...source.getDescendantsOfKind(SyntaxKind.ArrowFunction),
          ...source.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
        ]

        for (const fn of fnNodes) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fnAny = fn as any
          const body = fnAny.getBody?.()
          if (!body) continue

          const hasBlock = Node.isBlock(body)

          // React: don't auto-instrument component/hook params & returns — those
          // are compiler-checked internals, not boundaries. `Check<T>` still works.
          const skipReactAuto = enabled.react && isTsx && isReactComponentOrHook(functionLikeName(fn))

          // Params
          if (hasBlock) {
            const bodyOpenBrace = body.getStart()
            const paramValidations: { name: string; schema: string; boundary?: string }[] = []

            for (const param of fnAny.getParameters()) {
              const paramTypeNode = param.getTypeNode()
              if (!paramTypeNode) continue

              const checkInner = isCheckAnnotation(paramTypeNode)
              const effective  = checkInner ?? (mode === 'auto' && !skipReactAuto ? paramTypeNode : null)
              if (!effective) continue
              if (PRIMITIVE_KINDS.has(effective.getKind())) continue

              // Destructured params (`{ a, b }` / `[a, b]`) can't be reassigned at
              // the body top like a plain identifier — `{ a } = __check({ a })`
              // parses as a block, not an assignment (a hard SyntaxError). Skip
              // them; surface an explicit Check<T> so the author knows it didn't apply.
              const nameNode = param.getNameNode()
              if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
                if (checkInner) reportUnvalidated(paramTypeNode.getStart(), `param "${nameNode.getText()}"`)
                continue
              }

              const schema = typeNodeToSchema(effective, schemaCache, watchedFiles)
              const paramName = nameNode.getText()
              if (isNoopSchema(schema)) {
                // Auto-mode params are too numerous to warn on; an explicit
                // Check<T> that can't be validated is worth surfacing.
                if (checkInner) reportUnvalidated(paramTypeNode.getStart(), `param "${paramName}"`)
                continue
              }
              paramValidations.push({ name: paramName, schema, boundary: `param "${paramName}"` })

              if (checkInner) {
                ops.push({
                  kind: 'replaceType',
                  typeStart: paramTypeNode.getStart(),
                  typeEnd:   paramTypeNode.getEnd(),
                  text:      effective.getText(),
                })
              }
            }

            if (paramValidations.length > 0) {
              ops.push({ kind: 'paramValidate', pos: bodyOpenBrace + 1, params: paramValidations })
            }
          }

          // Return type
          const returnTypeNode = fnAny.getReturnTypeNode?.()
          if (!returnTypeNode) continue

          const checkInner = isCheckAnnotation(returnTypeNode)
          const effective  = checkInner ?? (mode === 'auto' && !skipReactAuto ? returnTypeNode : null)
          if (!effective) continue
          if (PRIMITIVE_KINDS.has(effective.getKind())) continue

          const returnSchema = typeNodeToSchema(effective, schemaCache, watchedFiles)
          if (isNoopSchema(returnSchema)) {
            if (checkInner) reportUnvalidated(returnTypeNode.getStart(), 'return')
            continue
          }

          if (checkInner) {
            ops.push({
              kind: 'replaceType',
              typeStart: returnTypeNode.getStart(),
              typeEnd:   returnTypeNode.getEnd(),
              text:      effective.getText(),
            })
          }

          if (hasBlock) {
            fn
              .getDescendantsOfKind(SyntaxKind.ReturnStatement)
              .filter(ret => nearestFunctionLike(ret) === fn)
              .forEach(ret => {
                const expr = ret.getExpression()
                if (!expr) return
                ops.push({ kind: 'wrap', initStart: expr.getStart(), initEnd: expr.getEnd(), schema: returnSchema, boundary: 'return' })
              })
          } else {
            ops.push({ kind: 'wrap', initStart: body.getStart(), initEnd: body.getEnd(), schema: returnSchema, boundary: 'return' })
          }
        }

        if (!ops.length) return null

        for (const f of watchedFiles) {
          if (f !== id) this.addWatchFile(f)
        }

        const ms = new MagicString(code)

        // ── How each boundary is wrapped ──────────────────────────────────
        // - live/dev   → `__guard` (Proxy, interpreter; perf doesn't matter).
        // - production → AOT: a specialized validator generated from the schema
        //   and run via `__runAot`. Recursive (`def`/`ref`) or un-generatable
        //   schemas fall back to the interpreter `__check`. Validators+schemas
        //   are deduped into hoisted module consts.
        const needImports = new Set<string>()
        const aot = new Map<string, { v: string; s: string }>()
        const aotDecls: string[] = []

        // Source-location embedding: on for the dev server by default, opt-in for
        // prod (keeps the bundle lean). Yields `{at:'file:line',b:'boundary'}`.
        const errLoc = options.errorLocation ?? 'auto'
        const wantLoc = errLoc === 'auto' ? isDev : !!errLoc
        const emitSchema = options.emitSchema ?? 'auto'
        const wantSchema = emitSchema === 'auto' ? isDev : !!emitSchema
        const metaFor = (absOffset: number, boundary?: string): string | undefined => {
          if (!wantLoc) return undefined
          const at = JSON.stringify(`${relFile}:${lineAt(absOffset)}`)
          return `{at:${at}${boundary ? `,b:${JSON.stringify(boundary)}` : ''}}`
        }

        /** Return the call fragments that wrap an expression for `schema`. */
        const wrapExpr = (schema: string, meta?: string): { prefix: string; suffix: string } => {
          if (useGuard) {
            needImports.add('__guard')
            return { prefix: `${GUARD_FN}(`, suffix: `, ${schema}${meta ? `, '(root)', ${meta}` : ''})` }
          }
          // Production: try to generate a specialized validator.
          if (!schema.includes("kind:'def'")) {
            let entry = aot.get(schema)
            if (!entry) {
              try {
                const resolved = new Function(`return (${schema})`)() as Parameters<typeof generate>[0]
                const { preamble, fn } = generate(resolved)
                const n = aot.size
                entry = { v: `__t12n_v${n}`, s: `__t12n_s${n}` }
                const validator = preamble ? `(() => {\n${preamble}\nreturn ${fn}\n})()` : fn
                if (wantSchema) aotDecls.push(`const ${entry.s} = ${schema};`)
                aotDecls.push(`const ${entry.v} = ${validator};`)
                aot.set(schema, entry)
              } catch {
                entry = undefined // un-generatable → fall through to __check
              }
            }
            if (entry) {
              needImports.add('aot')
              // schema literal only when wanted; keep `undefined` placeholder if a
              // meta arg follows so positions line up.
              const tail = [wantSchema ? entry.s : meta ? 'undefined' : '', meta].filter(Boolean).join(', ')
              return { prefix: `${RUNAOT_FN}(${entry.v}, `, suffix: tail ? `, ${tail})` : ')' }
            }
          }
          needImports.add('__check')
          return { prefix: `${CHECK_FN}(`, suffix: `, ${schema}${meta ? `, '(root)', ${meta}` : ''})` }
        }

        for (const op of ops) {
          if (op.kind === 'wrap') {
            const { prefix, suffix } = wrapExpr(op.schema, metaFor(op.initStart + baseOffset, op.boundary))
            ms.appendLeft(op.initStart + baseOffset, prefix)
            ms.appendLeft(op.initEnd + baseOffset, suffix)
          } else if (op.kind === 'paramValidate') {
            const text = op.params
              .map(p => {
                const { prefix, suffix } = wrapExpr(p.schema, metaFor(op.pos + baseOffset, p.boundary))
                return `${p.name} = ${prefix}${p.name}${suffix}`
              })
              .join('; ')
            ms.appendLeft(op.pos + baseOffset, ` ${text};`)
          } else if (op.kind === 'removeType') {
            ms.remove(op.colonStart + baseOffset, op.typeEnd + baseOffset)
          } else if (op.kind === 'replaceType') {
            ms.overwrite(op.typeStart + baseOffset, op.typeEnd + baseOffset, op.text)
          } else {
            ms.appendLeft(op.pos + baseOffset, op.text)
          }
        }

        // Import only the runtime helpers this file actually uses, then hoist the
        // generated validator/schema consts (they reference those imports).
        const specifiers: string[] = []
        if (needImports.has('__guard')) specifiers.push(`__guard as ${GUARD_FN}`)
        if (needImports.has('__check')) specifiers.push(`__check as ${CHECK_FN}`)
        if (needImports.has('aot')) {
          specifiers.push(`__runAot as ${RUNAOT_FN}`, `__aotFail as ${AOTFAIL_FN}`, `__FAIL as ${FAIL_SENTINEL}`)
        }
        const hasRuntimeImport = !!source.getImportDeclaration(
          d => d.getModuleSpecifierValue() === RUNTIME_IMPORT
        )
        const preamble =
          (hasRuntimeImport || specifiers.length === 0
            ? ''
            : `import { ${specifiers.join(', ')} } from '${RUNTIME_IMPORT}'\n`) +
          (aotDecls.length ? aotDecls.join('\n') + '\n' : '')
        // Insert at the start of the analysed region — for .vue that's just
        // inside <script>, not before the SFC.
        if (preamble) ms.appendLeft(baseOffset, preamble)

        transformCount++
        boundaryCount += ops.filter(op => op.kind === 'wrap').length

        return {
          code: ms.toString(),
          map: ms.generateMap({ hires: true, source: id, includeContent: true }),
        }
      } catch (e) {
        this.warn(`[t12n] Error transforming ${id}: ${e}`)
        return null
      }
    },

    buildEnd() {
      if (transformCount > 0) {
        console.log(`[t12n] transformed ${transformCount} files, wrapped ${boundaryCount} boundaries`)
      }
      if (onUnvalidated === 'error' && unvalidatedSites.length > 0) {
        const list = unvalidatedSites.map(s => `  - ${s}`).join('\n')
        throw new Error(
          `[t12n] ${unvalidatedSites.length} boundary(ies) resolve to a type that validates nothing ` +
          `(any/unknown). Set onUnvalidated:'warn' to allow, or tighten the types:\n${list}`,
        )
      }
    },
  }
})

export const t12n = (options: T12nOptions = {}): Plugin => unplugin.vite(options) as Plugin

export const rollupPlugin  = unplugin.rollup
export const webpackPlugin = unplugin.webpack
export const esbuildPlugin = unplugin.esbuild
export const rspackPlugin  = unplugin.rspack

export default t12n
