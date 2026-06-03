/**
 * t12n — type-driven runtime validation
 *
 * Public surface of the package root:
 *   - Type aliases: Check<T>, Unvalidated<T>, Validated<T>
 *   - One runtime export: ValidationError (for instanceof in catch blocks)
 *   - Ambient DOM overrides so fetch().json(), localStorage.getItem, etc.
 *     return Unvalidated<T> and the compiler refuses raw access.
 *
 * The validation runtime itself is in `@dnssfnv/t12n/runtime` — the plugin emits
 * imports there. End users should not import from /runtime directly.
 */

export { ValidationError, configure } from './runtime/index.js'
export type { ValidationIssue, T12nConfig, ViolationContext, ViolationHandler } from './runtime/index.js'

declare const __t12n_unvalidated: unique symbol
declare const __t12n_validated:   unique symbol

/**
 * Marker type recognised by the Vite plugin. In `mode: 'manual'` it is the
 * only way to ask for runtime validation. At compile time it is just `T` —
 * no narrowing, no brand — so any value assignable to `T` is accepted.
 *
 * ```ts
 * const user: Check<User> = await fetch('/api/me').then(r => r.json())
 * ```
 */
export type Check<T> = T

/**
 * Data that came from outside the program (fetch, storage, postMessage, …).
 * Branded so the compiler refuses raw reads until it has passed through a
 * check.
 */
export type Unvalidated<T = unknown> = T & { readonly [__t12n_unvalidated]: true }

/**
 * Data that has passed runtime validation. Returned by the plugin-injected
 * check at boundaries.
 */
export type Validated<T> = T & { readonly [__t12n_validated]: true }

/** True if T carries the Validated brand. */
export type IsValidated<T> = T extends { readonly [__t12n_validated]: true } ? true : false

// ───────────────────────────────────────────────────────────────────────────
// Ambient DOM overrides
// ───────────────────────────────────────────────────────────────────────────

declare global {
  // fetch / Response / Request bodies — all three reading methods
  interface Body {
    json<T = unknown>(): Promise<Unvalidated<T>>
    text(): Promise<Unvalidated<string>>
    formData(): Promise<Unvalidated<FormData>>
  }

  // localStorage / sessionStorage
  interface Storage {
    getItem(key: string): Unvalidated<string> | null
  }

  // Note: MessageEvent.data and Document.cookie are intentionally NOT
  // overridden here. TypeScript's interface merging requires properties
  // (not methods) to have identical types across declarations, so a
  // narrowing override is impossible. The Vite plugin still detects
  // `ev.data` on MessageEvent-typed receivers at build time via the
  // TypeChecker, so runtime protection is preserved.
}
