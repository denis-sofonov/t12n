# Benchmarks & how to "prove" t12n

"Is it actually good?" breaks down into four measurable things. Don't trust the
marketing — measure.

## 1. Runtime validation speed

```bash
pnpm build
pnpm add -D zod          # optional, enables the Zod row
node bench/runtime.bench.mjs
```

Validates a representative payload (100 users — nested address, tags, enum role)
50,000 times.

**Example run** (Apple Silicon, Node 24, numbers vary by machine):

| Validator         | ops/s   | vs t12n |
| :---------------- | ------: | :------ |
| `zod` 4 `.parse`  | ~27,300 | 1.6×    |
| **t12n `__check`**| ~17,100 | 1.0×    |
| `structuredClone` | ~5,700  | 0.3×    |

**Honest read:** t12n is the same order of magnitude as Zod, but **Zod 4 is
faster** — it compiles specialised validators, while t12n's runtime is a small
generic recursive walker. Both are far cheaper than a deep clone and plenty fast
for boundary validation. **Speed is not t12n's selling point** — zero schema
authoring, zero `validate()` calls, the `Unvalidated<T>` compiler pressure and
the live Proxy guard are. If raw throughput is your bottleneck, the schema
format is plain data and could be compiled to a specialised function later.

## 2. Bundle size

What actually ships to the browser is the consumed subset of `t12n/runtime`:

```bash
pnpm build
ls -la dist/runtime.js          # full runtime
# In a real app, only the imports you use are bundled. A prod build that uses
# only __check tree-shakes the Proxy guard away entirely.
npx esbuild --bundle --minify <your-entry> | wc -c
```

The schema literals are inlined per check site (plain data, no closures).

## 3. Build-time overhead

The plugin runs ts-morph's type-checker during `transform`, so measure the delta
on a real app:

```bash
# baseline — plugin off
T12N=off  time vite build
# instrumented
T12N=auto time vite build
```

Report the absolute delta and per-file cost. This is the number that matters for
adoption on large codebases.

## 4. Real-codebase case study (the actual proof)

Micro-benchmarks don't prove usefulness — catching real bugs does. On an existing
app:

1. Add the plugin in `auto` mode; `buildEnd` logs `transformed N files, wrapped M
   boundaries` — that's your coverage number.
2. Turn on `live: true` + an `onViolation` that reports, run the app/e2e suite,
   and count how many boundary or drift violations fire against **production-shaped
   data**. Each one is a bug your types were silently lying about.
3. Compare to the effort of hand-writing M validators by hand.

That ratio — boundaries covered & bugs surfaced per line of code you wrote
(zero) — is the honest case for t12n.
