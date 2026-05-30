/**
 * Live guard — the part that makes a t12n type a *runtime invariant* rather
 * than a one-shot snapshot.
 *
 * `check()` validates once at the boundary and hands back a plain object that
 * can immediately drift again (`user.age = "20"` slips right through). `guard()`
 * validates the same way, then wraps the result in a recursive Proxy that keeps
 * enforcing the type for the object's whole lifetime:
 *
 *   - writing an off-type value to a known property → reported as a mutation;
 *   - writing a property the type doesn't declare → reported;
 *   - deleting a required property → reported;
 *   - nested objects/arrays are wrapped lazily on first read (identity is
 *     preserved via a per-parent WeakMap, so `obj.a === obj.a`).
 *
 * "Reported" means routed through the configured `onViolation` handler — throw
 * (dev default), console, ship-to-backend, whatever the stage calls for.
 *
 * Cost: every property access on a guarded object goes through a trap, so this
 * is meant for the dev/staging stage (the plugin emits `__guard` only when its
 * `live` mode is on) — production keeps the plain, allocation-cheap `__check`.
 * Proxies also don't survive structured-clone boundaries (postMessage/worker),
 * which is fine: the receiving side re-guards at its own boundary.
 */
import { materialize, type Schema, type EmittedSchema } from './schema.js'
import { tryCheck, collectIssues } from './check.js'
import { ValidationError, type ValidationIssue } from './error.js'
import { report } from './config.js'

function joinPath(parent: string, key: string | number): string {
  return parent === '(root)' ? String(key) : `${parent}.${key}`
}

function isIndexKey(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key)
}

/** Build the issue + error and route it through the handler as a mutation. */
function reportMutation(path: string, issue: ValidationIssue, value: unknown, schema: Schema): void {
  const error = new ValidationError(issue, [issue])
  report({ site: 'mutation', path, error, issue, value, schema })
}

/** Validate a single incoming write; report if it doesn't fit `schema`. */
function checkMutation(value: unknown, schema: Schema, path: string): void {
  const r = tryCheck(value, schema, path)
  if (!r.ok) reportMutation(path, r.issue, value, schema)
}

/**
 * Entry point emitted by the plugin in live mode. Eager-validates (so the
 * initial shape is guaranteed and unknown keys are stripped), then wraps.
 */
export function guard<T>(value: unknown, schema: EmittedSchema, path = '(root)', meta?: { at?: string; b?: string }): T {
  const resolved = materialize(schema)
  // Eager pass routes through the boundary handler exactly like __check would.
  const r = tryCheck(value, resolved, path)
  if (!r.ok) {
    const site = meta && { source: meta.at, boundary: meta.b }
    const collected = collectIssues(value, resolved, path)
    const all = collected.length ? collected : [r.issue]
    const error = new ValidationError(all[0], all, site)
    report({ site: 'boundary', path: all[0].path, error, issue: all[0], value, schema: resolved, source: meta?.at, boundary: meta?.b })
  }
  return wrap(value, resolved, path) as T
}

function wrap(value: unknown, schema: Schema, path: string): unknown {
  // Unwrap nullability markers — guard the inner shape when present.
  if (schema.kind === 'optional') {
    return value === undefined ? value : wrap(value, schema.inner, path)
  }
  if (schema.kind === 'nullable') {
    return value === null ? value : wrap(value, schema.inner, path)
  }

  // Union — statically we can't tell which branch this value is, but at runtime
  // we can: guard it with the first branch it actually satisfies.
  if (schema.kind === 'union') {
    for (const opt of schema.options) {
      if (tryCheck(value, opt, path).ok) return wrap(value, opt, path)
    }
    return value
  }

  // Intersection of object parts — guard against the merged shape so writes to
  // any contributing property are still type-checked.
  if (schema.kind === 'intersection') {
    const merged = mergeObjectParts(schema.parts)
    return merged && value !== null && typeof value === 'object'
      ? objectProxy(value as Record<string, unknown>, merged, path)
      : value
  }

  if (value === null || typeof value !== 'object') return value

  switch (schema.kind) {
    case 'object': return objectProxy(value as Record<string, unknown>, schema, path)
    case 'record': return recordProxy(value as Record<string, unknown>, schema, path)
    case 'array':  return arrayProxy(value as unknown[], schema, path)
    case 'tuple':  return tupleProxy(value as unknown[], schema, path)
    // primitives / literals / enum: validated above, nothing to live-wrap.
    default:       return value
  }
}

/** Merge an intersection's object parts into one object schema, or null if any
 * part isn't a plain object shape. */
function mergeObjectParts(
  parts: readonly Schema[],
): { kind: 'object'; properties: Record<string, Schema>; optional?: readonly string[] } | null {
  const properties: Record<string, Schema> = {}
  const optional: string[] = []
  for (const part of parts) {
    if (part.kind !== 'object') return null
    Object.assign(properties, part.properties)
    if (part.optional) optional.push(...part.optional)
  }
  return { kind: 'object', properties, ...(optional.length ? { optional } : {}) }
}

function objectProxy(
  target: Record<string, unknown>,
  schema: { kind: 'object'; properties: Record<string, Schema>; optional?: readonly string[] },
  path: string,
): unknown {
  const children = new WeakMap<object, unknown>()
  const optional = schema.optional && schema.optional.length > 0 ? new Set(schema.optional) : null

  return new Proxy(target, {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv)
      if (typeof key === 'symbol') return v
      const propSchema = schema.properties[key]
      if (!propSchema || v === null || typeof v !== 'object') return v
      let w = children.get(v as object)
      if (w === undefined) {
        w = wrap(v, propSchema, joinPath(path, key))
        children.set(v as object, w)
      }
      return w
    },
    set(t, key, val, recv) {
      if (typeof key === 'symbol') return Reflect.set(t, key, val, recv)
      const propSchema = schema.properties[key]
      if (!propSchema) {
        reportMutation(joinPath(path, key), {
          path: joinPath(path, key),
          expected: '(property not declared on this type)',
          received: val,
        }, val, schema)
      } else {
        checkMutation(val, propSchema, joinPath(path, key))
      }
      // Handler returned without throwing → apply the write.
      return Reflect.set(t, key, val, recv)
    },
    deleteProperty(t, key) {
      if (typeof key === 'string') {
        const propSchema = schema.properties[key]
        const isOptional = !propSchema || propSchema.kind === 'optional' || (optional?.has(key) ?? false)
        if (propSchema && !isOptional) {
          reportMutation(joinPath(path, key), {
            path: joinPath(path, key),
            expected: 'required property (must not be deleted)',
            received: undefined,
          }, undefined, schema)
        }
      }
      return Reflect.deleteProperty(t, key)
    },
  })
}

function recordProxy(
  target: Record<string, unknown>,
  schema: { kind: 'record'; element: Schema },
  path: string,
): unknown {
  const children = new WeakMap<object, unknown>()
  return new Proxy(target, {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv)
      if (typeof key === 'symbol' || v === null || typeof v !== 'object') return v
      let w = children.get(v as object)
      if (w === undefined) {
        w = wrap(v, schema.element, joinPath(path, key))
        children.set(v as object, w)
      }
      return w
    },
    set(t, key, val, recv) {
      if (typeof key !== 'symbol') checkMutation(val, schema.element, joinPath(path, key))
      return Reflect.set(t, key, val, recv)
    },
  })
}

function arrayProxy(
  target: unknown[],
  schema: { kind: 'array'; element: Schema },
  path: string,
): unknown {
  const children = new WeakMap<object, unknown>()
  return new Proxy(target, {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv)
      if (typeof key === 'symbol' || !isIndexKey(key) || v === null || typeof v !== 'object') return v
      let w = children.get(v as object)
      if (w === undefined) {
        w = wrap(v, schema.element, joinPath(path, key))
        children.set(v as object, w)
      }
      return w
    },
    set(t, key, val, recv) {
      // Element writes (incl. those from push/splice) hit numeric-index keys.
      if (typeof key === 'string' && isIndexKey(key)) {
        checkMutation(val, schema.element, joinPath(path, key))
      }
      return Reflect.set(t, key, val, recv)
    },
  })
}

function tupleProxy(
  target: unknown[],
  schema: { kind: 'tuple'; elements: readonly Schema[] },
  path: string,
): unknown {
  const children = new WeakMap<object, unknown>()
  return new Proxy(target, {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv)
      if (typeof key === 'symbol' || !isIndexKey(key)) return v
      const elemSchema = schema.elements[Number(key)]
      if (!elemSchema || v === null || typeof v !== 'object') return v
      let w = children.get(v as object)
      if (w === undefined) {
        w = wrap(v, elemSchema, joinPath(path, key))
        children.set(v as object, w)
      }
      return w
    },
    set(t, key, val, recv) {
      if (typeof key === 'string' && isIndexKey(key)) {
        const elemSchema = schema.elements[Number(key)]
        if (elemSchema) {
          checkMutation(val, elemSchema, joinPath(path, key))
        } else {
          reportMutation(joinPath(path, key), {
            path: joinPath(path, key),
            expected: `tuple of length ${schema.elements.length} (index out of range)`,
            received: val,
          }, val, schema)
        }
      }
      return Reflect.set(t, key, val, recv)
    },
  })
}
