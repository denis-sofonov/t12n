/**
 * AOT code generation — turn a resolved `Schema` into JavaScript *source* for a
 * specialized validator. The Vite plugin can inline this source into the bundle
 * (no runtime `eval`, CSP-safe), reaching hand-written validator speed instead
 * of paying the schema-as-data interpreter's dynamic `value[key]` + `in` cost.
 *
 * The generated function has the same protocol as the runtime's compiled
 * validators: it returns the parsed value (unknown object keys stripped) on
 * success, or the shared `FAIL` sentinel on the first mismatch, recording the
 * offending path/expectation in a module-local `issue`. A thin wrapper (the
 * equivalent of `check()`) turns `FAIL` into a thrown/reported ValidationError.
 *
 * `generate` returns the function source plus a preamble of hoisted constants
 * (enum membership Sets). Kinds the generator can't specialize throw
 * `Unsupported`, signalling the caller to fall back to the interpreter.
 */
import type { Schema } from '../runtime/schema.js'

export class Unsupported extends Error {}

// Names the generated code expects in scope. The plugin imports them from the
// runtime (`aotFail as __t12n_fail`, `FAIL as __t12n_FAIL`); benches inject them.
const FAIL_FN = '__t12n_fail'
const FAIL_SENTINEL = '__t12n_FAIL'

export interface Generated {
  /** Hoisted `const` declarations the function body refers to (e.g. enum Sets). */
  preamble: string
  /** Function expression source: `(v) => { … }`. */
  fn: string
}

/**
 * Could validating `schema` ever return a value *different* from its input?
 * Only containers that strip (object) or whose children transform do. Pure
 * primitives/enums/literals never coerce. When the answer is `false` the
 * generator validates in place and returns the original reference — matching
 * the interpreter's copy-on-write, so e.g. `record<number>` allocates nothing.
 */
function transforms(schema: Schema): boolean {
  switch (schema.kind) {
    case 'object':
    case 'intersection':
      return true // object strips unknown keys; intersection merges
    case 'array':
    case 'record':
      return transforms(schema.element)
    case 'tuple':
      return schema.elements.some(transforms)
    case 'optional':
    case 'nullable':
      return transforms(schema.inner)
    case 'union':
      return schema.options.some(transforms)
    default:
      return false // string/number/boolean/bigint/null/undefined/void/any/unknown/never/literal/enum
  }
}

const isIdent = (k: string) => /^[A-Za-z_$][\w$]*$/.test(k)
const access = (base: string, key: string) => (isIdent(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`)

class Ctx {
  private n = 0
  consts: string[] = []
  fresh(prefix = 't') {
    return `${prefix}${this.n++}`
  }
  /** Hoist a constant expression, return its identifier. */
  hoist(expr: string): string {
    const id = `C${this.consts.length}`
    this.consts.push(`const ${id} = ${expr};`)
    return id
  }
}

/**
 * Emit statements that validate `src` against `schema` and bind the parsed
 * result. Returns the code plus the expression holding the result (often `src`
 * itself for primitives, since t12n never coerces).
 *
 * `path` is a JS expression (string-typed) for the current location, used when
 * recording a failure. Static segments are folded into the literal; dynamic
 * ones (array indices) are interpolated.
 */
function gen(schema: Schema, src: string, path: string, ctx: Ctx): { code: string; out: string } {
  const failTo = (expected: string) =>
    `return ${FAIL_FN}(${path}, ${JSON.stringify(expected)}, ${src});`

  switch (schema.kind) {
    case 'any':
    case 'unknown':
      return { code: '', out: src }
    case 'never':
      return { code: `if (true) ${failTo('never')}`, out: src }

    case 'string':
      return { code: `if (typeof ${src} !== 'string') ${failTo('string')}`, out: src }
    case 'number':
      return { code: `if (typeof ${src} !== 'number' || ${src} !== ${src}) ${failTo('number')}`, out: src }
    case 'boolean':
      return { code: `if (typeof ${src} !== 'boolean') ${failTo('boolean')}`, out: src }
    case 'bigint':
      return { code: `if (typeof ${src} !== 'bigint') ${failTo('bigint')}`, out: src }
    case 'null':
      return { code: `if (${src} !== null) ${failTo('null')}`, out: src }
    case 'undefined':
    case 'void':
      return { code: `if (${src} !== undefined) ${failTo(schema.kind)}`, out: src }

    case 'literal': {
      const lit = JSON.stringify(schema.value)
      const expected = typeof schema.value === 'string' ? `"${schema.value}"` : String(schema.value)
      return { code: `if (${src} !== ${lit}) ${failTo(expected)}`, out: src }
    }

    case 'enum': {
      const set = ctx.hoist(`new Set(${JSON.stringify(schema.values)})`)
      const expected = schema.values.map(v => `"${v}"`).join(' | ')
      return {
        code: `if (typeof ${src} !== 'string' || !${set}.has(${src})) ${failTo(expected)}`,
        out: src,
      }
    }

    case 'instance':
      // `name` is a global constructor (Date, Map, …), available in module scope.
      return { code: `if (!(${src} instanceof ${schema.name})) ${failTo(schema.name)}`, out: src }

    case 'optional': {
      const out = ctx.fresh('o')
      const inner = gen(schema.inner, src, path, ctx)
      return {
        code: `let ${out};\nif (${src} === undefined) { ${out} = undefined; }\nelse { ${inner.code}\n${out} = ${inner.out}; }`,
        out,
      }
    }
    case 'nullable': {
      const out = ctx.fresh('o')
      const inner = gen(schema.inner, src, path, ctx)
      return {
        code: `let ${out};\nif (${src} === null) { ${out} = null; }\nelse { ${inner.code}\n${out} = ${inner.out}; }`,
        out,
      }
    }

    case 'array': {
      const i = ctx.fresh('i')
      const e = ctx.fresh('e')
      // Index coerced to string so the recorded path is always string-typed.
      const elemPath = path === '""' ? `'' + ${i}` : `${path} + '.' + ${i}`
      const el = gen(schema.element, e, elemPath, ctx)
      if (!transforms(schema.element)) {
        // Elements never coerce → validate in place, return the original array.
        return {
          code:
            `if (!Array.isArray(${src})) ${failTo('array')}\n` +
            `for (let ${i} = 0; ${i} < ${src}.length; ${i}++) {\nconst ${e} = ${src}[${i}];\n${el.code}\n}`,
          out: src,
        }
      }
      const out = ctx.fresh('a')
      return {
        code:
          `if (!Array.isArray(${src})) ${failTo('array')}\n` +
          `const ${out} = new Array(${src}.length);\n` +
          `for (let ${i} = 0; ${i} < ${src}.length; ${i}++) {\n` +
          `const ${e} = ${src}[${i}];\n${el.code}\n${out}[${i}] = ${el.out};\n}`,
        out,
      }
    }

    case 'tuple': {
      const n = schema.elements.length
      const rebuild = schema.elements.some(transforms)
      const out = rebuild ? ctx.fresh('tp') : src
      let body = `if (!Array.isArray(${src}) || ${src}.length !== ${n}) ${failTo(`tuple of length ${n}`)}\n`
      if (rebuild) body += `const ${out} = new Array(${n});\n`
      schema.elements.forEach((elSchema, idx) => {
        const e = ctx.fresh('e')
        const elemPath = path === '""' ? `'${idx}'` : `${path} + '.${idx}'`
        const el = gen(elSchema, e, elemPath, ctx)
        body += `const ${e} = ${src}[${idx}];\n${el.code}\n` + (rebuild ? `${out}[${idx}] = ${el.out};\n` : '')
      })
      return { code: body, out }
    }

    case 'object': {
      const out = ctx.fresh('ob')
      const props = schema.properties
      const optional = schema.optional
      let body =
        `if (${src} === null || typeof ${src} !== 'object' || Array.isArray(${src})) ${failTo('object')}\n` +
        `const ${out} = {};\n`
      for (const key in props) {
        const fieldSchema = props[key]
        const isOptional = (optional !== undefined && optional.includes(key)) || fieldSchema.kind === 'optional'
        const skipMissing = isOptional || fieldSchema.kind === 'any' || fieldSchema.kind === 'unknown'
        const acc = access(src, key)
        const keyPath = path === '""' ? `'${key}'` : `${path} + '.${key}'`
        const v = ctx.fresh('v')
        const inner = gen(fieldSchema, v, keyPath, ctx)
        const assign = isIdent(key) ? `${out}.${key}` : `${out}[${JSON.stringify(key)}]`
        // `'key' in src` distinguishes a present-but-undefined value from a
        // missing one (matching the interpreter). Optional-undefined is dropped.
        const presence = `(${JSON.stringify(key)} in ${src})`
        if (skipMissing) {
          body +=
            `if (${presence}) {\nconst ${v} = ${acc};\n${inner.code}\n` +
            (isOptional ? `if (${inner.out} !== undefined) ${assign} = ${inner.out};\n}` : `${assign} = ${inner.out};\n}`)
        } else {
          body +=
            `if (!${presence}) return ${FAIL_FN}(${keyPath}, ${JSON.stringify(describe(fieldSchema))}, undefined);\n` +
            `const ${v} = ${acc};\n${inner.code}\n${assign} = ${inner.out};\n`
        }
      }
      return { code: body, out }
    }

    case 'record': {
      // Keys are not known statically → dynamic iteration.
      const k = ctx.fresh('k')
      const v = ctx.fresh('v')
      const keyPath = path === '""' ? `${k}` : `${path} + '.' + ${k}`
      const el = gen(schema.element, v, keyPath, ctx)
      const guard = `if (${src} === null || typeof ${src} !== 'object' || Array.isArray(${src})) ${failTo('object')}\n`
      if (!transforms(schema.element)) {
        // Values never coerce and record keeps all keys → return src unchanged.
        return {
          code: `${guard}for (const ${k} in ${src}) {\nconst ${v} = ${src}[${k}];\n${el.code}\n}`,
          out: src,
        }
      }
      const out = ctx.fresh('rc')
      return {
        code:
          `${guard}const ${out} = {};\nfor (const ${k} in ${src}) {\nconst ${v} = ${src}[${k}];\n${el.code}\n${out}[${k}] = ${el.out};\n}`,
        out,
      }
    }

    case 'union': {
      // Try each branch in a fresh scope; first that doesn't FAIL wins. We can't
      // statically pick, so each branch is generated and guarded by a flag.
      const out = ctx.fresh('un')
      const matched = ctx.fresh('m')
      let body = `let ${out}, ${matched} = false;\n`
      for (const opt of schema.options) {
        const branch = gen(opt, src, path, ctx)
        // Run the branch's checks; a FAIL inside would `return` from the whole
        // function, so we instead wrap branch logic in an IIFE returning a
        // sentinel. Simpler: re-implement try-branch via a helper closure.
        const probe = ctx.fresh('p')
        body +=
          `if (!${matched}) {\nconst ${probe} = (() => {\n${branch.code}\nreturn ${branch.out};\n})();\n` +
          `if (${probe} !== ${FAIL_SENTINEL}) { ${out} = ${probe}; ${matched} = true; }\n}\n`
      }
      const expected = schema.options.map(describe).join(' | ')
      body += `if (!${matched}) ${failTo(expected)}`
      return { code: body, out }
    }

    case 'intersection': {
      // Validate every part; merge object outputs (matches the interpreter).
      const out = ctx.fresh('is')
      let body = `let ${out};\n`
      let first = true
      for (const part of schema.parts) {
        const p = gen(part, src, path, ctx)
        body += p.code + '\n'
        body += first ? `${out} = ${p.out};\n` : `${out} = (${out} && typeof ${out} === 'object' && ${p.out} && typeof ${p.out} === 'object') ? { ...${out}, ...${p.out} } : ${p.out};\n`
        first = false
      }
      return { code: body, out }
    }
  }
}

/** Minimal `describe` for embedding expected-type strings into generated code. */
function describe(schema: Schema): string {
  switch (schema.kind) {
    case 'literal': return typeof schema.value === 'string' ? `"${schema.value}"` : String(schema.value)
    case 'enum': return schema.values.map(v => `"${v}"`).join(' | ')
    case 'instance': return schema.name
    case 'array': return `array<${describe(schema.element)}>`
    case 'object': return 'object'
    case 'record': return `record<${describe(schema.element)}>`
    case 'optional': return `${describe(schema.inner)} | undefined`
    case 'nullable': return `${describe(schema.inner)} | null`
    default: return schema.kind
  }
}

/**
 * Generate validator source for `schema`. Assumes an acyclic schema: recursive
 * (`def`/`ref`) types are filtered out by the caller (see vite/index.ts) and
 * left to the interpreter, so this walk always terminates. A kind it cannot
 * specialize throws {@link Unsupported}, signalling the caller to fall back.
 */
export function generate(schema: Schema): Generated {
  const ctx = new Ctx()
  const { code, out } = gen(schema, 'v', '""', ctx)
  return {
    preamble: ctx.consts.join('\n'),
    fn: `(v) => {\n${code}\nreturn ${out};\n}`,
  }
}
