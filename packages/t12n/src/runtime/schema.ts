/**
 * Schema-as-data — the resolved format the runtime validator consumes.
 *
 * Plain objects, no classes/closures/methods. Recursive types are represented
 * as genuine cyclic object references (built by `materialize` below), so the
 * validator never needs a separate ref-resolution step — it just recurses,
 * guided by the (finite) data.
 */

export type Schema =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'bigint' }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'void' }
  | { kind: 'any' }
  | { kind: 'unknown' }
  | { kind: 'never' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'enum'; values: readonly string[] }
  // Built-in class instances (Date, Map, Set, RegExp, Promise, …) — validated
  // by `instanceof` the named global constructor. `name` is always a global.
  | { kind: 'instance'; name: string }
  | { kind: 'array'; element: Schema }
  | { kind: 'tuple'; elements: readonly Schema[] }
  | { kind: 'object'; properties: Record<string, Schema>; optional?: readonly string[] }
  | { kind: 'record'; element: Schema }
  | { kind: 'union'; options: readonly Schema[] }
  | { kind: 'intersection'; parts: readonly Schema[] }
  | { kind: 'optional'; inner: Schema }
  | { kind: 'nullable'; inner: Schema }

/**
 * Wire format — what the Vite plugin actually emits into your bundle.
 *
 * It is JSON-serializable: recursive types can't be expressed as cyclic
 * literals in source, so the plugin hoists each recursive type into a named
 * entry under `def.defs` and points at it with `{ kind: 'ref' }`. A `def`
 * wrapper only appears when recursion is present; everything else is emitted
 * as a plain `Schema` literal, byte-for-byte as before.
 */
export type SchemaRef = { kind: 'ref'; name: string }
export type SchemaDef = { kind: 'def'; defs: Record<string, EmittedSchema>; schema: EmittedSchema }
export type EmittedSchema =
  | Schema
  | SchemaRef
  | SchemaDef
  // Composite nodes in the wire format may themselves carry refs.
  | { kind: 'array'; element: EmittedSchema }
  | { kind: 'tuple'; elements: readonly EmittedSchema[] }
  | { kind: 'object'; properties: Record<string, EmittedSchema>; optional?: readonly string[] }
  | { kind: 'record'; element: EmittedSchema }
  | { kind: 'union'; options: readonly EmittedSchema[] }
  | { kind: 'intersection'; parts: readonly EmittedSchema[] }
  | { kind: 'optional'; inner: EmittedSchema }
  | { kind: 'nullable'; inner: EmittedSchema }

/**
 * Resolve an emitted (wire) schema into a runtime `Schema`. For the common,
 * non-recursive case the input is already a plain `Schema` and this is a
 * no-op. For a `def` wrapper it builds each named definition once and wires
 * `ref` nodes to genuine object references — producing a cyclic, ref-free
 * structure the validator can walk directly.
 */
export function materialize(schema: EmittedSchema): Schema {
  if (schema.kind !== 'def') return schema as Schema

  const { defs, schema: root } = schema
  const built: Record<string, Schema> = {}
  for (const name in defs) built[name] = {} as Schema // stable placeholders

  const memo = new Map<EmittedSchema, Schema>()
  // Seed def nodes to their placeholders so refs and direct hits agree.
  for (const name in defs) memo.set(defs[name], built[name])

  const res = (node: EmittedSchema): Schema => {
    if (node.kind === 'ref') return built[node.name]
    const hit = memo.get(node)
    if (hit) return hit
    const out = {} as Schema
    memo.set(node, out)
    Object.assign(out, cloneNode(node, res))
    return out
  }

  for (const name in defs) Object.assign(built[name], cloneNode(defs[name], res))
  return res(root)
}

function cloneNode(node: EmittedSchema, res: (n: EmittedSchema) => Schema): Schema {
  switch (node.kind) {
    case 'array':
    case 'record':
      return { kind: node.kind, element: res(node.element) } as Schema
    case 'tuple':
      return { kind: 'tuple', elements: node.elements.map(res) }
    case 'object': {
      const properties: Record<string, Schema> = {}
      for (const k in node.properties) properties[k] = res(node.properties[k])
      return node.optional
        ? { kind: 'object', properties, optional: node.optional }
        : { kind: 'object', properties }
    }
    case 'union':
      return { kind: 'union', options: node.options.map(res) }
    case 'intersection':
      return { kind: 'intersection', parts: node.parts.map(res) }
    case 'optional':
    case 'nullable':
      return { kind: node.kind, inner: res(node.inner) } as Schema
    default:
      // primitives, literal, enum — no nested schemas to resolve
      return { ...(node as Schema) }
  }
}
