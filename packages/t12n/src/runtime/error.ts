/**
 * A single validation failure. Errors carry one top-level issue plus an
 * optional `nested` array — populated when a union branch failed and we
 * want to surface each branch's reason.
 */
export interface ValidationIssue {
  path: string
  expected: string
  received: unknown
  nested?: ValidationIssue[]
}

function safeStringify(value: unknown): string {
  try {
    const str = JSON.stringify(value)
    if (str && str.length > 200) return str.slice(0, 200) + '…'
    return str ?? String(value)
  } catch {
    return `[${typeof value}]`
  }
}

function describeReceived(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return `${typeof value} (${safeStringify(value)})`
}

/** Where the failing check sits in *your* source — filled in by the plugin. */
export interface ErrorSite {
  /** Original (pre-build) location, e.g. `src/pages/Profile.vue:42`. */
  source?: string
  /** The boundary that produced the value, e.g. `fetch().json()` or `param "user"`. */
  boundary?: string
}

function buildMessage(top: ValidationIssue, issues: ValidationIssue[], site?: ErrorSite): string {
  const where = site?.source ? ` · ${site.source}` : ''
  const why = site?.boundary ? `  (${site.boundary})` : ''
  // One boundary, every failing field — list them all when there's more than one.
  if (issues.length > 1) {
    const lines = issues
      .map(i => `  ${i.path}\n    expected   ${i.expected}\n    received   ${describeReceived(i.received)}`)
      .join('\n\n')
    return `[t12n] Validation failed${where}${why} — ${issues.length} issues\n\n${lines}`
  }
  return (
    `[t12n] Validation failed${where}${why}\n\n` +
    `  ${top.path}\n` +
    `    expected   ${top.expected}\n` +
    `    received   ${describeReceived(top.received)}`
  )
}

export class ValidationError extends Error {
  readonly path: string
  readonly expected: string
  readonly received: unknown
  readonly issues: ValidationIssue[]
  /** Source location of the check (`file:line`), when the build embedded it. */
  readonly source?: string
  /** The boundary that produced the value, when known. */
  readonly boundary?: string

  constructor(top: ValidationIssue, issues: ValidationIssue[] = [top], site?: ErrorSite) {
    super(buildMessage(top, issues, site))
    this.name = 'ValidationError'
    this.path = top.path
    this.expected = top.expected
    this.received = top.received
    this.issues = issues
    this.source = site?.source
    this.boundary = site?.boundary

    if ('captureStackTrace' in Error) {
      (Error as unknown as { captureStackTrace(t: unknown, c: unknown): void })
        .captureStackTrace(this, ValidationError)
    }
  }
}
