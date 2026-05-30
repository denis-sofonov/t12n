/**
 * AOT codegen benchmark — does generated, statically-accessed validator source
 * hold its speed across the type surface (objects, unions, optionals, records,
 * tuples), or only on flat objects?
 *
 *   pnpm build && node bench/codegen.bench.mjs
 *
 * For each schema it (1) verifies the generated validator agrees with the
 * runtime interpreter on sample data, then (2) reports best-of-N ops/s for the
 * interpreter vs the generated validator (and zod where comparable).
 */
import { performance } from 'node:perf_hooks'
import { __check } from '../dist/runtime.js'
import { generate } from '../dist/codegen.js'

const FAIL = Symbol('fail')
const failStub = (_path, _expected, _received) => FAIL // generated code calls __t12n_fail(...)

/** Instantiate generated source. In production the plugin inlines this and the
 *  runtime supplies the helpers; here we inject them to measure raw speed. */
function makeValidator(schema) {
  const { preamble, fn } = generate(schema)
  const factory = new Function('__t12n_FAIL', '__t12n_fail', `${preamble}\nreturn ${fn};`)
  return factory(FAIL, failStub)
}

/** Interpreter result as a value (or the string 'FAIL' on rejection). */
function interp(data, schema) {
  try { return JSON.stringify(__check(data, schema)) }
  catch { return 'FAIL' }
}
function gened(validate, data) {
  const r = validate(data)
  return r === FAIL ? 'FAIL' : JSON.stringify(r)
}

const ITERS = 20_000, TRIALS = 6
function best(name, fn) {
  for (let i = 0; i < 3_000; i++) fn()
  let b = 0
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now()
    for (let i = 0; i < ITERS; i++) fn()
    const o = ITERS / ((performance.now() - t0) / 1000)
    if (o > b) b = o
  }
  console.log('  ' + name.padEnd(24), `${Math.round(b).toLocaleString()} ops/s`.padStart(16))
}

// ── schemas + sample data ──────────────────────────────────────────────────
const userObj = {
  kind: 'object', properties: {
    id: { kind: 'number' }, name: { kind: 'string' }, email: { kind: 'string' }, active: { kind: 'boolean' },
    address: { kind: 'object', properties: { street: { kind: 'string' }, zip: { kind: 'string' } } },
    tags: { kind: 'array', element: { kind: 'string' } },
    role: { kind: 'enum', values: ['admin', 'user'] },
  },
}
const mkUser = i => ({
  id: i, name: `u${i}`, email: `u${i}@x.com`, active: i % 2 === 0,
  address: { street: '1 Main', zip: '00000' }, tags: ['a', 'b', 'c'], role: i % 3 === 0 ? 'admin' : 'user',
})

const cases = [
  {
    label: 'ARRAY<OBJECT> · flat',
    schema: { kind: 'array', element: userObj },
    data: Array.from({ length: 100 }, (_, i) => mkUser(i)),
    extras: Array.from({ length: 100 }, (_, i) => ({ ...mkUser(i), createdAt: 'x', _v: 3, address: { street: '1 Main', zip: '00000', country: 'US' } })),
  },
  {
    label: 'ARRAY<UNION>',
    schema: {
      kind: 'array', element: {
        kind: 'union', options: [
          { kind: 'object', properties: { t: { kind: 'literal', value: 'a' }, x: { kind: 'number' } } },
          { kind: 'object', properties: { t: { kind: 'literal', value: 'b' }, y: { kind: 'string' } } },
        ],
      },
    },
    data: Array.from({ length: 100 }, (_, i) => i % 2 ? { t: 'a', x: i } : { t: 'b', y: `s${i}` }),
  },
  {
    label: 'ARRAY<OPTIONAL fields>',
    schema: {
      kind: 'array', element: {
        kind: 'object',
        properties: { id: { kind: 'number' }, nick: { kind: 'optional', inner: { kind: 'string' } }, bio: { kind: 'optional', inner: { kind: 'string' } } },
      },
    },
    data: Array.from({ length: 100 }, (_, i) => i % 2 ? { id: i, nick: `n${i}` } : { id: i, nick: `n${i}`, bio: 'hi' }),
  },
  {
    label: 'RECORD<NUMBER>',
    schema: { kind: 'record', element: { kind: 'number' } },
    data: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])),
  },
  {
    label: 'ARRAY<TUPLE>',
    schema: { kind: 'array', element: { kind: 'tuple', elements: [{ kind: 'number' }, { kind: 'string' }, { kind: 'boolean' }] } },
    data: Array.from({ length: 100 }, (_, i) => [i, `s${i}`, i % 2 === 0]),
  },
]

let zArr = null
try {
  const { z } = await import('zod')
  zArr = z.array(z.object({
    id: z.number(), name: z.string(), email: z.string(), active: z.boolean(),
    address: z.object({ street: z.string(), zip: z.string() }),
    tags: z.array(z.string()), role: z.enum(['admin', 'user']),
  }))
} catch { /* optional */ }

for (const c of cases) {
  console.log(`\n${c.label}`)
  const validate = makeValidator(c.schema)

  // correctness gate
  const datasets = [['clean', c.data], ...(c.extras ? [['extras', c.extras]] : [])]
  let okAll = true
  for (const [tag, d] of datasets) {
    const a = interp(d, c.schema), b = gened(validate, d)
    const ok = a === b
    okAll &&= ok
    if (!ok) console.log(`  ✗ MISMATCH (${tag}): interp=${a.slice(0, 60)} … gen=${b.slice(0, 60)}`)
  }
  if (okAll) console.log('  ✓ matches interpreter')

  for (const [tag, d] of datasets) {
    if (datasets.length > 1) console.log(`  — ${tag}`)
    best('interpreter __check', () => __check(d, c.schema))
    best('codegen', () => validate(d))
    if (zArr && c.label.startsWith('ARRAY<OBJECT>')) best('zod parse', () => zArr.parse(d))
  }
}
console.log()
