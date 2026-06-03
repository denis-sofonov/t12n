/**
 * t12n plugin for rollup — same engine as `@dnssfnv/t12n/vite`, wired through unplugin.
 *
 *   // rollup config
 *   import t12n from '@dnssfnv/t12n/rollup'
 *   plugins: [ t12n({ mode: 'auto' }) ]
 */
export { rollupPlugin as default } from './vite/index.js'
