import { materialize, type Schema, type EmittedSchema } from './schema.js'
import { ValidationError, type ValidationIssue, type ErrorSite } from './error.js'
import { report } from './config.js'

/**
 * Build-embedded location/boundary for a check site. The plugin emits this as a
 * compact literal — `{at:'file:line', b:'fetch().json()'}` — to keep the bundle
 * lean; {@link toSite} expands it into the public {@link ErrorSite} shape
 * (`source` / `boundary`) carried by `ValidationError`.
 */
export type CheckMeta = { at?: string; b?: string }

/** Expand the compact wire meta the plugin emits into a public ErrorSite. */
function toSite(meta?: CheckMeta): ErrorSite | undefined {
  return meta && { source: meta.at, boundary: meta.b }
}

/**
 * Recursive structural validator.
 *
 * Hot-path design: `run` returns the parsed value on success and the `FAIL`
 * sentinel on failure — no `{ ok, value }` wrapper is allocated per node, and
 * no path string is built while things are valid. On failure the offending
 * leaf records `failIssue` (module-local, safe because validation is
 * synchronous and the first failure short-circuits), and each enclosing
 * checker prepends its key, so the dotted path is assembled only as the error
 * unwinds.
 *
 * On a mismatch the failure is routed through the configured violation handler
 * (see `configure`): by default a ValidationError is thrown; with a
 * non-throwing handler the original value is returned so the app keeps running.
 *
 * On success returns the parsed value. For objects, unknown keys are stripped.
 */
export function check<T>(value: unknown, schema: EmittedSchema, path = '(root)', meta?: CheckMeta): T {
  const resolved = materialize(schema)
  const result = run(value, resolved)
  if (result !== FAIL) return result as T
  finalizePath(failIssue, path)
  // Cold path: gather *every* failing leaf, not just the first — one boundary
  // yields one error carrying the full list. `collectIssues` re-walks via `run`
  // (overwriting `failIssue`), so capture the first issue before it runs.
  const first = { ...failIssue }
  const issues = collectIssues(value, resolved, path)
  const all = issues.length ? issues : [first]
  const error = new ValidationError(all[0], all, toSite(meta))
  report({ site: 'boundary', path: all[0].path, error, issue: all[0], value, schema: resolved, source: meta?.at, boundary: meta?.b })
  // Reached only when a handler chose not to throw: pass the value through.
  return value as T
}

/**
 * Non-throwing, non-reporting structural check. Returns the first issue (if
 * any) without constructing a ValidationError or invoking the handler — the
 * live guard uses this so it can attach `site: 'mutation'` context itself.
 */
export function tryCheck(
  value: unknown,
  schema: EmittedSchema,
  path = '(root)',
): { ok: true } | { ok: false; issue: ValidationIssue } {
  const result = run(value, materialize(schema))
  if (result !== FAIL) return { ok: true }
  finalizePath(failIssue, path)
  return { ok: false, issue: failIssue }
}

// ---------------------------------------------------------------------------
// Failure plumbing — a sentinel + one module-local issue. `run` never returns
// a wrapper for valid values, so the success path allocates nothing beyond the
// rebuilt (strip-unknown) containers.
// ---------------------------------------------------------------------------

export const FAIL = Symbol('t12n.fail')
let failIssue!: ValidationIssue

function fail(expected: string, received: unknown): typeof FAIL {
  failIssue = { path: '', expected, received }
  return FAIL
}

/** Prepend `key` to the bubbling failure path (built leaf-first). */
function under(key: string | number): typeof FAIL {
  failIssue.path = failIssue.path ? `${key}.${failIssue.path}` : String(key)
  return FAIL
}

/** Turn the relative bubbled path into an absolute one for reporting. */
function finalizePath(issue: ValidationIssue, base: string): void {
  if (issue.path === '') issue.path = base
  else if (base !== '(root)') issue.path = `${base}.${issue.path}`
}

// ---------------------------------------------------------------------------
// AOT entry points — used by the specialized validators the Vite plugin
// generates at build time (see vite/codegen.ts). A generated validator returns
// the parsed value on success or the shared `FAIL` sentinel on the first
// mismatch, recording the offending location via `aotFail`. `runAot` then turns
// a FAIL into exactly the reported/thrown ValidationError that `check` would —
// so the two paths are behaviourally identical at the boundary.
// ---------------------------------------------------------------------------

let aotIssue!: ValidationIssue

/** Called by generated code at a mismatch. `path` is the full path from root
 *  (built statically during codegen), so no leaf-first assembly is needed. */
export function aotFail(path: string, expected: string, received: unknown): typeof FAIL {
  aotIssue = { path, expected, received }
  return FAIL
}

/**
 * Run a generated validator and route failure through the violation handler,
 * mirroring `check`. `schema` is the emitted (wire) schema literal, materialized
 * lazily only on the cold failure path for the ViolationContext.
 */
export function runAot<T>(
  validator: (value: unknown) => unknown,
  value: unknown,
  schema?: EmittedSchema,
  meta?: CheckMeta,
): T {
  const result = validator(value)
  if (result !== FAIL) return result as T
  finalizePath(aotIssue, '(root)')
  // Collect the full list when the schema is available (always in dev; in lean
  // prod builds `emitSchema:false` drops it, so we degrade to the first issue
  // the generated validator already recorded).
  const resolved = schema ? materialize(schema) : undefined
  const issues = resolved ? collectIssues(value, resolved, '(root)') : []
  const all = issues.length ? issues : [aotIssue]
  const error = new ValidationError(all[0], all, toSite(meta))
  report({ site: 'boundary', path: all[0].path, error, issue: all[0], value, schema: resolved ?? ({ kind: 'unknown' } as Schema), source: meta?.at, boundary: meta?.b })
  // Reached only when a handler chose not to throw: pass the value through.
  return value as T
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Collect-all — cold failure path. Gather *every* failing leaf in `value`
// against `schema`, each with its full dotted path, so one boundary surfaces
// one error carrying the complete list. Only ever called after the hot `run()`
// returned FAIL, so valid data never pays for the extra traversal. Containers
// recurse; leaves / unions / intersections / instances are judged by a single
// `run` so their (possibly nested) reason is preserved.
// ---------------------------------------------------------------------------

export function collectIssues(value: unknown, schema: Schema, base: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const join = (p: string, k: string | number) =>
    p === '(root)' || p === '' ? String(k) : `${p}.${k}`

  const walk = (v: unknown, s: Schema, path: string): void => {
    switch (s.kind) {
      case 'optional':
        if (v !== undefined) walk(v, s.inner, path)
        return
      case 'nullable':
        if (v !== null) walk(v, s.inner, path)
        return
      case 'object': {
        if (!isPlainObject(v)) { issues.push({ path, expected: 'object', received: v }); return }
        const optional = s.optional
        for (const key in s.properties) {
          const fs = s.properties[key]
          const isOptional = (optional !== undefined && optional.includes(key)) || fs.kind === 'optional'
          if (!(key in v)) {
            if (!isOptional && fs.kind !== 'any' && fs.kind !== 'unknown') {
              issues.push({ path: join(path, key), expected: describe(fs), received: undefined })
            }
            continue
          }
          walk(v[key], fs, join(path, key))
        }
        return
      }
      case 'record':
        if (!isPlainObject(v)) { issues.push({ path, expected: 'object', received: v }); return }
        for (const key in v) walk(v[key], s.element, join(path, key))
        return
      case 'array':
        if (!Array.isArray(v)) { issues.push({ path, expected: 'array', received: v }); return }
        for (let i = 0; i < v.length; i++) walk(v[i], s.element, join(path, i))
        return
      case 'tuple':
        if (!Array.isArray(v) || v.length !== s.elements.length) {
          issues.push({ path, expected: `tuple of length ${s.elements.length}`, received: v }); return
        }
        for (let i = 0; i < s.elements.length; i++) walk(v[i], s.elements[i], join(path, i))
        return
      default: {
        // primitives, literal, enum, instance, union, intersection, any/unknown/never/void
        if (run(v, s) === FAIL) {
          const rel = failIssue.path
          const full = rel ? join(path, rel) : (path === '' ? '(root)' : path)
          issues.push({ path: full, expected: failIssue.expected, received: failIssue.received, nested: failIssue.nested })
        }
      }
    }
  }

  walk(value, schema, base)
  return issues
}

// ---------------------------------------------------------------------------
// describe — failure path only (never called while valid)
// ---------------------------------------------------------------------------

// `seen` carries the ancestor chain so recursive (cyclic) schemas don't loop
// forever — a back-edge renders as `…`.
function describe(schema: Schema, seen?: Set<Schema>): string {
  if (seen?.has(schema)) return '…'
  const next = () => {
    const s = new Set(seen)
    s.add(schema)
    return s
  }
  switch (schema.kind) {
    case 'string':    return 'string'
    case 'number':    return 'number'
    case 'boolean':   return 'boolean'
    case 'bigint':    return 'bigint'
    case 'null':      return 'null'
    case 'undefined': return 'undefined'
    case 'void':      return 'void'
    case 'any':       return 'any'
    case 'unknown':   return 'unknown'
    case 'never':     return 'never'
    case 'literal':   return typeof schema.value === 'string' ? `"${schema.value}"` : String(schema.value)
    case 'enum':      return schema.values.map(v => `"${v}"`).join(' | ')
    case 'instance':  return schema.name
    case 'array':     return `array<${describe(schema.element, next())}>`
    case 'tuple':     return `[${schema.elements.map(e => describe(e, next())).join(', ')}]`
    case 'object':    return 'object'
    case 'record':    return `record<${describe(schema.element, next())}>`
    case 'union':     return schema.options.map(o => describe(o, next())).join(' | ')
    case 'intersection': return schema.parts.map(p => describe(p, next())).join(' & ')
    case 'optional':  return `${describe(schema.inner, next())} | undefined`
    case 'nullable':  return `${describe(schema.inner, next())} | null`
  }
}

// ---------------------------------------------------------------------------
// Main dispatch — returns the parsed value, or the FAIL sentinel.
// ---------------------------------------------------------------------------

function run(value: unknown, schema: Schema): unknown {
  switch (schema.kind) {
    case 'any':
    case 'unknown':
      return value
    case 'never':
      return fail('never', value)

    case 'string':
      return typeof value === 'string' ? value : fail('string', value)

    case 'number':
      return typeof value === 'number' && !Number.isNaN(value) ? value : fail('number', value)

    case 'boolean':
      return typeof value === 'boolean' ? value : fail('boolean', value)

    case 'bigint':
      return typeof value === 'bigint' ? value : fail('bigint', value)

    case 'null':
      return value === null ? value : fail('null', value)

    case 'undefined':
    case 'void':
      return value === undefined ? value : fail(schema.kind, value)

    case 'literal':
      return value === schema.value ? value : fail(describe(schema), value)

    case 'enum':
      return typeof value === 'string' && schema.values.includes(value)
        ? value
        : fail(describe(schema), value)

    case 'instance': {
      const ctor = (globalThis as Record<string, unknown>)[schema.name]
      return typeof ctor === 'function' && value instanceof (ctor as new (...args: never[]) => unknown)
        ? value
        : fail(schema.name, value)
    }

    case 'array':        return checkArray(value, schema)
    case 'tuple':        return checkTuple(value, schema)
    case 'object':       return checkObject(value, schema)
    case 'record':       return checkRecord(value, schema)
    case 'union':        return checkUnion(value, schema)
    case 'intersection': return checkIntersection(value, schema)

    case 'optional':
      return value === undefined ? undefined : run(value, schema.inner)
    case 'nullable':
      return value === null ? null : run(value, schema.inner)
  }
}

// ---------------------------------------------------------------------------
// Composite checkers
// ---------------------------------------------------------------------------

function checkArray(value: unknown, schema: { kind: 'array'; element: Schema }): unknown {
  if (!Array.isArray(value)) return fail('array', value)
  const el = schema.element
  const out: unknown[] = new Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const r = run(value[i], el)
    if (r === FAIL) return under(i)
    out[i] = r
  }
  return out
}

function checkTuple(value: unknown, schema: { kind: 'tuple'; elements: readonly Schema[] }): unknown {
  const n = schema.elements.length
  if (!Array.isArray(value) || value.length !== n) return fail(`tuple of length ${n}`, value)
  const out: unknown[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const r = run(value[i], schema.elements[i])
    if (r === FAIL) return under(i)
    out[i] = r
  }
  return out
}

function checkObject(
  value: unknown,
  schema: { kind: 'object'; properties: Record<string, Schema>; optional?: readonly string[] },
): unknown {
  if (!isPlainObject(value)) return fail('object', value)

  const optional = schema.optional
  const out: Record<string, unknown> = {}
  // Iterate schema keys — drives strip-unknown for free.
  for (const key in schema.properties) {
    const fieldSchema = schema.properties[key]
    const isOptional = (optional !== undefined && optional.includes(key)) || fieldSchema.kind === 'optional'

    if (!(key in value)) {
      if (isOptional || fieldSchema.kind === 'any' || fieldSchema.kind === 'unknown') continue
      failIssue = { path: key, expected: describe(fieldSchema), received: undefined }
      return FAIL
    }

    const r = run(value[key], fieldSchema)
    if (r === FAIL) return under(key)
    if (r === undefined && isOptional) continue // don't serialize optional-undefined
    out[key] = r
  }
  return out
}

function checkRecord(value: unknown, schema: { kind: 'record'; element: Schema }): unknown {
  if (!isPlainObject(value)) return fail('object', value)
  const el = schema.element
  const out: Record<string, unknown> = {}
  for (const key in value) {
    const r = run(value[key], el)
    if (r === FAIL) return under(key)
    out[key] = r
  }
  return out
}

/**
 * Union — try every branch; first match wins. On total failure surface the
 * branch whose error went deepest (usually "you almost matched this one").
 */
function checkUnion(value: unknown, schema: { kind: 'union'; options: readonly Schema[] }): unknown {
  const failures: ValidationIssue[] = []
  for (const opt of schema.options) {
    const r = run(value, opt)
    if (r !== FAIL) return r
    failures.push(failIssue)
  }
  let best = failures[0]
  for (const f of failures) if (f.path.length > best.path.length) best = f
  failIssue = { path: best.path, expected: describe(schema), received: value, nested: failures }
  return FAIL
}

/**
 * Intersection — validate all parts. Merge object outputs; otherwise return the
 * original value once all parts agreed.
 */
function checkIntersection(
  value: unknown,
  schema: { kind: 'intersection'; parts: readonly Schema[] },
): unknown {
  let merged: unknown
  let allObjects = true
  for (const part of schema.parts) {
    const r = run(value, part)
    if (r === FAIL) return FAIL // failIssue already set; caller prepends
    if (isPlainObject(r)) {
      merged = isPlainObject(merged) ? { ...merged, ...r } : r
    } else {
      allObjects = false
      merged = r
    }
  }
  return allObjects ? merged : value
}
