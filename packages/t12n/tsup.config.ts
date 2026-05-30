import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index:   'src/index.ts',
    vite:    'src/vite/index.ts',
    runtime: 'src/runtime/index.ts',
    webpack: 'src/webpack.ts',
    rollup:  'src/rollup.ts',
    esbuild: 'src/esbuild.ts',
    rspack:  'src/rspack.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  splitting: true,
  cjsInterop: true,
})
