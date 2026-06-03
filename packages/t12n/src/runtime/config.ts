/**
 * Runtime configuration — one global hook that decides what happens when a
 * validation fails.
 *
 * t12n derives schemas and inserts checks at build time, but *what to do* on a
 * violation is a per-stage policy decision the bundle can't make for you:
 *
 *   - dev:        throw (default) or console.warn — fail loud, fix the type.
 *   - production: report to your backend and KEEP THE APP ALIVE — a bad API
 *                 payload should be telemetry, not a white screen.
 *
 * You wire that policy once, at app entry, with `configure({ onViolation })`.
 * The same handler fires for boundary failures (bad incoming data) and, in
 * live/guard mode, for out-of-type mutations.
 */
import type { Schema } from './schema.js'
import type { ValidationIssue } from './error.js'
import type { ValidationError } from './error.js'

export interface ViolationContext {
  /**
   * Where the violation was detected.
   *   - 'boundary': data failed validation as it entered (fetch/parse/param/…).
   *   - 'mutation': a guarded (live) object was written with an off-type value.
   */
  site: 'boundary' | 'mutation'
  /** Dotted path to the offending value, e.g. `"user.address.zip"`. */
  path: string
  /** The constructed error — this is also what gets thrown by default. */
  error: ValidationError
  /** The top-level issue (path / expected / received / nested). */
  issue: ValidationIssue
  /** The value that failed. */
  value: unknown
  /** The schema it was checked against. */
  schema: Schema
  /** Original (pre-build) location of the check, e.g. `src/App.vue:42` — when embedded. */
  source?: string
  /** The boundary that produced the value, e.g. `fetch().json()` — when known. */
  boundary?: string
}

export type ViolationHandler = (ctx: ViolationContext) => void

export interface T12nConfig {
  /**
   * Called on every validation failure.
   *
   * If the handler **returns normally**, t12n does NOT throw:
   *   - boundary failures let the offending value pass through unchanged;
   *   - mutations are applied to the target anyway.
   * This is the production "report, don't crash" path.
   *
   * To abort instead (the dev default), **throw** from inside the handler —
   * re-throwing `ctx.error` keeps the original message and stack.
   *
   * Pass `null` to reset to the default behaviour (always throw).
   */
  onViolation?: ViolationHandler | null
}

let handler: ViolationHandler | null = null

/**
 * Install (or clear) the global violation policy. Call once at app start,
 * typically branching on your build stage:
 *
 * ```ts
 * import { configure } from '@dnssfnv/t12n'
 *
 * configure({
 *   onViolation: import.meta.env.PROD
 *     ? ({ error, path, value }) => {
 *         navigator.sendBeacon('/t12n', JSON.stringify({ path, msg: error.message }))
 *       }                                   // prod: ship it, app survives
 *     : ({ error }) => console.warn(error.message),  // dev: loud, non-fatal
 * })
 * ```
 */
export function configure(config: T12nConfig): void {
  if ('onViolation' in config) handler = config.onViolation ?? null
}

/** True if a custom handler is installed (i.e. failures won't throw by default). */
export function hasViolationHandler(): boolean {
  return handler !== null
}

/**
 * Internal — route a failure through the configured handler. With no handler
 * the error is thrown (preserving t12n's default fail-fast behaviour). With a
 * handler that returns normally, control comes back to the caller, which then
 * decides how to proceed (pass the value through / apply the write).
 */
export function report(ctx: ViolationContext): void {
  if (handler) {
    handler(ctx)
    return
  }
  throw ctx.error
}
