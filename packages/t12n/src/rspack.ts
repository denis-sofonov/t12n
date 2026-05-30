/**
 * t12n plugin for rspack — same engine as `t12n/vite`, wired through unplugin.
 *
 *   // rspack config
 *   import t12n from 't12n/rspack'
 *   plugins: [ t12n({ mode: 'auto' }) ]
 */
export { rspackPlugin as default } from './vite/index.js'
