# Benchmarks & how to "prove" t12n

"Is it actually good?" breaks down into four measurable things. Don't trust the
marketing — measure.

## 1. Runtime validation speed

```bash
pnpm build
pnpm add -D zod          # optional, enables the Zod row
pnpm bench:runtime       # or: pnpm bench  (runtime + codegen)
```

Validates a representative payload (100 users — nested address, tags, enum role).
Reports best-of-N ops/s per row to cut JIT/GC noise. There are two t12n rows: the
**AOT** validator the Vite plugin actually inlines into your bundle, and the
generic `__check` **interpreter** used as a fallback when no schema was compiled.

**Example run** (Apple Silicon, Node 24, numbers vary by machine):

| Validator              | ops/s    | vs t12n AOT |
| :--------------------- | -------: | :---------- |
| hand-written (ceiling) | ~800,000 | 1.2×        |
| **t12n AOT (shipped)** | ~655,000 | 1.0×        |
| `zod` 4 `.parse`       |  ~76,000 | 0.12×       |
| t12n `__check` (interp)|  ~37,000 | 0.06×       |

**Honest read:** the path that ships — the plugin-compiled **AOT** validator —
runs within ~20% of a hand-written check and lands around **8× Zod 4**, because
both compile specialised, straight-line field access. The generic `__check`
interpreter (fallback, no plugin) is the slow row and trails Zod; if you see that
number, the boundary wasn't compiled. Speed still isn't the *main* selling point
— zero schema authoring, zero `validate()` calls, the `Unvalidated<T>` compiler
pressure and the live Proxy guard are — but the shipped path is genuinely fast.

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
