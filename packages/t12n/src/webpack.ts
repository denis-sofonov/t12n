/**
 * t12n plugin for webpack — same engine as `@dnssfnv/t12n/vite`, wired through unplugin.
 *
 *   // webpack config
 *   import t12n from '@dnssfnv/t12n/webpack'
 *   plugins: [ t12n({ mode: 'auto' }) ]
 */
export { webpackPlugin as default } from './vite/index.js'
