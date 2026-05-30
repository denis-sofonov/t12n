/**
 * Runtime validation micro-benchmark.
 *
 *   pnpm build && node bench/runtime.bench.mjs
 *
 * Compares t12n's runtime `__check` against Zod (if installed) and a baseline.
 * Runs several trials and reports the best ops/s of each to cut JIT/GC noise.
 * For the Zod row: `pnpm add -D zod`.
 */
import { performance } from 'node:perf_hooks'
import { __check, __runAot, __aotFail, __FAIL } from '../dist/runtime.js'
import { generate } from '../dist/codegen.js'

// Build the validator exactly as the Vite plugin emits it (AOT): generate
// specialized source, instantiate with the runtime's helpers in scope, and run
// it through `__runAot` (the production wrapper) — so this row is the real
// shipped path, not a hand-tuned one.
function aotValidator(schema) {
  const { preamble, fn } = generate(schema)
  return new Function('__t12n_FAIL', '__t12n_fail', `${preamble}\nreturn ${fn}`)(__FAIL, __aotFail)
}

// Hand-written validator for the exact shape below — the speed ceiling. The
// fastest a correct check can run in JS: static field access, no abstraction.
// Apples-to-apples with t12n: it also rebuilds each object, stripping unknown
// keys, so both do the same work. The reference for "how close is the generated
// code to what you'd write by hand?" (more meaningful than a deep clone).
const ROLES = new Set(['admin', 'user'])
function handCheck(arr) {
  if (!Array.isArray(arr)) return false
  const out = new Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    const u = arr[i]
    if (u === null || typeof u !== 'object') return false
    if (typeof u.id !== 'number' || u.id !== u.id) return false
    if (typeof u.name !== 'string') return false
    if (typeof u.email !== 'string') return false
    if (typeof u.active !== 'boolean') return false
    const a = u.address
    if (a === null || typeof a !== 'object' || typeof a.street !== 'string' || typeof a.zip !== 'string') return false
    const t = u.tags
    if (!Array.isArray(t)) return false
    for (let j = 0; j < t.length; j++) if (typeof t[j] !== 'string') return false
    if (typeof u.role !== 'string' || !ROLES.has(u.role)) return false
    out[i] = {
      id: u.id, name: u.name, email: u.email, active: u.active,
      address: { street: a.street, zip: a.zip }, tags: t, role: u.role,
    }
  }
  return out
}

const schema = {
  kind: 'array',
  element: {
    kind: 'object',
    properties: {
      id: { kind: 'number' },
      name: { kind: 'string' },
      email: { kind: 'string' },
      active: { kind: 'boolean' },
      address: { kind: 'object', properties: { street: { kind: 'string' }, zip: { kind: 'string' } } },
      tags: { kind: 'array', element: { kind: 'string' } },
      role: { kind: 'enum', values: ['admin', 'user'] },
    },
  },
}

// "clean": matches the type exactly. "extras": real-API style, more fields than
// the type uses (so t12n must strip them).
const clean = Array.from({ length: 100 }, (_, i) => ({
  id: i, name: `user-${i}`, email: `user${i}@example.com`, active: i % 2 === 0,
  address: { street: '1 Main St', zip: '00000' },
  tags: ['alpha', 'beta', 'gamma'],
  role: i % 3 === 0 ? 'admin' : 'user',
}))
const extras = clean.map(u => ({
  ...u, createdAt: '2024-01-01', _v: 3, internalFlags: { a: 1, b: 2 },
  address: { ...u.address, country: 'US', extra: true },
}))

const ITERS = 20_000
const TRIALS = 6

function best(name, fn) {
  for (let i = 0; i < 3_000; i++) fn() // warm up
  let bestOps = 0
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now()
    for (let i = 0; i < ITERS; i++) fn()
    const ops = ITERS / ((performance.now() - t0) / 1000)
    if (ops > bestOps) bestOps = ops
  }
  console.log(name.padEnd(20), `${Math.round(bestOps).toLocaleString()} ops/s`.padStart(18))
}

let zschema = null
try {
  const { z } = await import('zod')
  zschema = z.array(z.object({
    id: z.number(), name: z.string(), email: z.string(), active: z.boolean(),
    address: z.object({ street: z.string(), zip: z.string() }),
    tags: z.array(z.string()), role: z.enum(['admin', 'user']),
  }))
} catch { /* zod optional */ }

const aot = aotValidator(schema)

for (const [label, data] of [['CLEAN (no extra keys)', clean], ['WITH EXTRA KEYS', extras]]) {
  console.log(`\n${label} · 100 users · best of ${TRIALS} × ${ITERS.toLocaleString()}\n`)
  best('hand-written (ceiling)', () => handCheck(data))
  best('t12n AOT (prod)', () => __runAot(aot, data, schema))
  best('t12n __check (interp)', () => __check(data, schema))
  if (zschema) best('zod parse', () => zschema.parse(data))
}
if (!zschema) console.log('\nzod not installed — `pnpm add -D zod` to add the Zod row.')
console.log()
