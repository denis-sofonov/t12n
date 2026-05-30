/**
 * t12n runtime — internal entry point used by code emitted by the plugin.
 * End users do not import from here directly.
 */
export { check as __check } from './check.js'
export { guard as __guard } from './guard.js'
// AOT validators emitted by the plugin call these.
export { runAot as __runAot, aotFail as __aotFail, FAIL as __FAIL } from './check.js'
export { configure, hasViolationHandler } from './config.js'
export { ValidationError } from './error.js'
export type { Schema } from './schema.js'
export type { ValidationIssue } from './error.js'
export type { T12nConfig, ViolationContext, ViolationHandler } from './config.js'
