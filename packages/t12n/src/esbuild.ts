/**
 * t12n plugin for esbuild — same engine as `t12n/vite`, wired through unplugin.
 *
 *   // esbuild config
 *   import t12n from 't12n/esbuild'
 *   plugins: [ t12n({ mode: 'auto' }) ]
 */
export { esbuildPlugin as default } from './vite/index.js'
