# t12n — typevalidation

Type-driven runtime validation for TypeScript. A tiny build plugin (Vite, webpack,
Rollup, esbuild, Rspack) that turns your TypeScript types into runtime validators:
annotate the data that crosses a boundary, and the schemas, checks and errors write
themselves.

```ts
const user: User = await fetch('/api/me').then(r => r.json())
// the plugin inserts the runtime check — a bad payload throws right here
```

## Repository layout

This is a pnpm workspace (`packages/*` + `site`).

| Path | What |
| :--- | :--- |
| [`packages/t12n`](packages/t12n) | The package — build plugin + runtime + types. Published to npm as **`@dnssfnv/t12n`**. |
| [`site`](site) | Astro site: landing page, guide and interactive playground (EN + RU). Deployed to Vercel as **t12n.vercel.app**. |

## Develop

```bash
pnpm install
pnpm -r build                  # build all packages (t12n + site)
pnpm -r test                   # run tests
pnpm --filter @dnssfnv/t12n dev    # build the package in watch mode
pnpm --filter @t12n/site dev   # run the site locally
```

## Publishing

- **Package → npm:** `cd packages/t12n && npm publish` (only `dist` ships, per the
  package's `files` field — not the whole monorepo).
- **Site → Vercel:** configured by the root [`vercel.json`](vercel.json) — build
  `pnpm --filter @t12n/site build`, output `site/dist`. The site build compiles the
  `t12n` package first, then runs `astro build` and the Pagefind search index.

## License

[MIT](LICENSE)
