import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Project } from 'ts-morph'
import { typeNodeToSchema } from '../vite/schema-gen.js'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let project: Project
let dir: string

function schemaOf(fileName: string, varName: string): string {
  const source = project.getSourceFileOrThrow(join(dir, fileName))
  const decl = source.getVariableDeclarationOrThrow(varName)
  const typeNode = decl.getTypeNode()
  if (!typeNode) throw new Error(`No type annotation on ${varName}`)
  return typeNodeToSchema(typeNode)
}

/** Parses the emitted schema string back into a JS object for structural asserts. */
function parseSchema(src: string): unknown {
  // The generator emits compact JS object literals (single-quoted keys for
  // strings, no spaces). Eval safely in a function to materialise them.
  return new Function(`return (${src})`)()
}

beforeAll(() => {
  dir = join(tmpdir(), `t12n-schema-gen-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  writeFileSync(join(dir, 'types.ts'), `
export interface Base { id: number }

export interface User extends Base {
  email?: string
  name: string
  role: 'admin' | 'user'
}

export interface Admin extends User {
  department: string
}

export type PartialUser   = Partial<User>
export type PickUser      = Pick<User, 'id' | 'name'>
export type OmitUser      = Omit<User, 'role'>
export type RequiredUser  = Required<User>

export type RecordOfUser  = { [k: string]: User }
export type Inter         = { a: string } & { b: number }

export interface Tree { value: string; children: Tree[] }
`)

  // Two DISTINCT interfaces that share the name `Dup` — used to prove the
  // schema cache keys by declaration identity, not just by text.
  writeFileSync(join(dir, 'dup-a.ts'), `export interface Dup { a: string }\n`)
  writeFileSync(join(dir, 'dup-b.ts'), `export interface Dup { b: number }\n`)

  writeFileSync(join(dir, 'main.ts'), `
import type {
  User, Admin, PartialUser, PickUser, OmitUser, RequiredUser,
  RecordOfUser, Inter, Tree,
} from './types'

const t_str: string = null as any
const t_num: number = null as any
const t_bool: boolean = null as any
const t_null: null = null as any
const t_undef: undefined = null as any
const t_any: any = null as any
const t_unknown: unknown = null as any
const t_never: never = null as any
const t_void: void = null as any
const t_bigint: bigint = null as any

const t_str_lit: 'hello' = null as any
const t_num_lit: 42 = null as any
const t_true_lit: true = null as any
const t_false_lit: false = null as any

const t_arr_str: string[] = null as any
const t_arr_gen: Array<number> = null as any

const t_tuple: [string, number, boolean] = null as any

const t_union_null: string | null = null as any
const t_union_undef: string | undefined = null as any
const t_union_both: string | null | undefined = null as any
const t_union_types: string | number = null as any
const t_str_enum: 'a' | 'b' | 'c' = null as any

const t_user: User = null as any
const t_admin: Admin = null as any
const t_partial: PartialUser = null as any
const t_pick: PickUser = null as any
const t_omit: OmitUser = null as any
const t_required: RequiredUser = null as any

const t_inline: { x: number; y?: string } = null as any
const t_record: RecordOfUser = null as any
const t_inter: Inter = null as any

const t_tree: Tree = null as any

const t_dup_a: import('./dup-a').Dup = null as any
const t_dup_b: import('./dup-b').Dup = null as any

const t_date: Date = null as any
const t_map: Map<string, number> = null as any
const t_set: Set<number> = null as any
const t_regexp: RegExp = null as any
const t_uint8: Uint8Array = null as any
const t_numidx: { [k: number]: string } = null as any
const t_tmpl: \`id_\${number}\` = null as any
const t_date_field: { when: Date; tags: string[] } = null as any
const t_index_props: { name: string; [k: string]: string } = null as any
`)

  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2020' },
    include: ['*.ts'],
  }))

  project = new Project({ tsConfigFilePath: join(dir, 'tsconfig.json') })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe('primitives', () => {
  it('string',    () => expect(parseSchema(schemaOf('main.ts', 't_str'))).toEqual({ kind: 'string' }))
  it('number',    () => expect(parseSchema(schemaOf('main.ts', 't_num'))).toEqual({ kind: 'number' }))
  it('boolean',   () => expect(parseSchema(schemaOf('main.ts', 't_bool'))).toEqual({ kind: 'boolean' }))
  it('null',      () => expect(parseSchema(schemaOf('main.ts', 't_null'))).toEqual({ kind: 'null' }))
  it('undefined', () => expect(parseSchema(schemaOf('main.ts', 't_undef'))).toEqual({ kind: 'undefined' }))
  it('any',       () => expect(parseSchema(schemaOf('main.ts', 't_any'))).toEqual({ kind: 'any' }))
  it('unknown',   () => expect(parseSchema(schemaOf('main.ts', 't_unknown'))).toEqual({ kind: 'unknown' }))
  it('never',     () => expect(parseSchema(schemaOf('main.ts', 't_never'))).toEqual({ kind: 'never' }))
  it('void',      () => expect(parseSchema(schemaOf('main.ts', 't_void'))).toEqual({ kind: 'void' }))
  it('bigint',    () => expect(parseSchema(schemaOf('main.ts', 't_bigint'))).toEqual({ kind: 'bigint' }))
})

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

describe('literals', () => {
  it('string',  () => expect(parseSchema(schemaOf('main.ts', 't_str_lit'))).toEqual({ kind: 'literal', value: 'hello' }))
  it('number',  () => expect(parseSchema(schemaOf('main.ts', 't_num_lit'))).toEqual({ kind: 'literal', value: 42 }))
  it('true',    () => expect(parseSchema(schemaOf('main.ts', 't_true_lit'))).toEqual({ kind: 'literal', value: true }))
  it('false',   () => expect(parseSchema(schemaOf('main.ts', 't_false_lit'))).toEqual({ kind: 'literal', value: false }))
})

// ---------------------------------------------------------------------------
// Arrays & tuples
// ---------------------------------------------------------------------------

describe('arrays & tuples', () => {
  it('string[]', () => {
    expect(parseSchema(schemaOf('main.ts', 't_arr_str')))
      .toEqual({ kind: 'array', element: { kind: 'string' } })
  })

  it('Array<number>', () => {
    expect(parseSchema(schemaOf('main.ts', 't_arr_gen')))
      .toEqual({ kind: 'array', element: { kind: 'number' } })
  })

  it('[string, number, boolean]', () => {
    expect(parseSchema(schemaOf('main.ts', 't_tuple')))
      .toEqual({
        kind: 'tuple',
        elements: [{ kind: 'string' }, { kind: 'number' }, { kind: 'boolean' }],
      })
  })
})

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

describe('unions', () => {
  it('string | null → nullable', () => {
    expect(parseSchema(schemaOf('main.ts', 't_union_null')))
      .toEqual({ kind: 'nullable', inner: { kind: 'string' } })
  })

  it('string | undefined → optional', () => {
    expect(parseSchema(schemaOf('main.ts', 't_union_undef')))
      .toEqual({ kind: 'optional', inner: { kind: 'string' } })
  })

  it('string | null | undefined → optional(nullable)', () => {
    expect(parseSchema(schemaOf('main.ts', 't_union_both')))
      .toEqual({ kind: 'optional', inner: { kind: 'nullable', inner: { kind: 'string' } } })
  })

  it('string | number → union', () => {
    expect(parseSchema(schemaOf('main.ts', 't_union_types')))
      .toEqual({ kind: 'union', options: [{ kind: 'string' }, { kind: 'number' }] })
  })

  it("'a' | 'b' | 'c' → enum", () => {
    expect(parseSchema(schemaOf('main.ts', 't_str_enum')))
      .toEqual({ kind: 'enum', values: ['a', 'b', 'c'] })
  })
})

// ---------------------------------------------------------------------------
// Inline object
// ---------------------------------------------------------------------------

describe('inline object', () => {
  it('{ x: number; y?: string } → object with optional list', () => {
    const s = parseSchema(schemaOf('main.ts', 't_inline')) as {
      kind: string; properties: Record<string, unknown>; optional?: string[]
    }
    expect(s.kind).toBe('object')
    expect(s.properties.x).toEqual({ kind: 'number' })
    expect(s.properties.y).toEqual({ kind: 'string' })
    expect(s.optional).toEqual(['y'])
  })
})

// ---------------------------------------------------------------------------
// Cross-file resolution
// ---------------------------------------------------------------------------

describe('cross-file resolution', () => {
  it('User resolves with all members including inherited id and optional email', () => {
    const s = parseSchema(schemaOf('main.ts', 't_user')) as {
      kind: string; properties: Record<string, unknown>; optional?: string[]
    }
    expect(s.kind).toBe('object')
    expect(s.properties.id).toEqual({ kind: 'number' })
    expect(s.properties.name).toEqual({ kind: 'string' })
    expect(s.properties.email).toEqual({ kind: 'string' })
    expect(s.optional).toEqual(['email'])
    expect(s.properties.role).toEqual({ kind: 'enum', values: ['admin', 'user'] })
  })

  it('Admin includes all User fields plus department (extends chain)', () => {
    const s = parseSchema(schemaOf('main.ts', 't_admin')) as {
      kind: string; properties: Record<string, unknown>
    }
    expect(s.properties.id).toBeDefined()
    expect(s.properties.name).toBeDefined()
    expect(s.properties.department).toEqual({ kind: 'string' })
  })
})

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

describe('utility types', () => {
  it('Partial<User> — all fields become optional', () => {
    const s = parseSchema(schemaOf('main.ts', 't_partial')) as {
      kind: string; properties: Record<string, unknown>; optional?: string[]
    }
    expect(s.optional?.sort()).toEqual(['email', 'id', 'name', 'role'])
  })

  it('Pick<User, "id" | "name"> — only those fields present', () => {
    const s = parseSchema(schemaOf('main.ts', 't_pick')) as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(s.properties).sort()).toEqual(['id', 'name'])
  })

  it('Omit<User, "role"> — role absent', () => {
    const s = parseSchema(schemaOf('main.ts', 't_omit')) as {
      properties: Record<string, unknown>
    }
    expect(s.properties.role).toBeUndefined()
    expect(s.properties.id).toBeDefined()
  })

  it('Required<User> — email no longer optional', () => {
    const s = parseSchema(schemaOf('main.ts', 't_required')) as {
      properties: Record<string, unknown>; optional?: string[]
    }
    expect(s.optional).toBeUndefined()
    // email field is plain string, not wrapped in { kind: 'optional' }
    expect(s.properties.email).toEqual({ kind: 'string' })
  })
})

// ---------------------------------------------------------------------------
// Intersection
// ---------------------------------------------------------------------------

describe('intersection', () => {
  it('{a:string} & {b:number} → intersection', () => {
    const s = parseSchema(schemaOf('main.ts', 't_inter')) as {
      kind: string; parts: unknown[]
    }
    expect(s.kind).toBe('intersection')
    expect(s.parts).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Index signatures
// ---------------------------------------------------------------------------

describe('index signatures', () => {
  it('{ [k: string]: User } → record', () => {
    const s = parseSchema(schemaOf('main.ts', 't_record')) as {
      kind: string; element: { kind: string }
    }
    expect(s.kind).toBe('record')
    expect(s.element.kind).toBe('object')
  })

  it('named props + index signature → intersection of object & record', () => {
    const s = parseSchema(schemaOf('main.ts', 't_index_props')) as {
      kind: string; parts: { kind: string; properties?: Record<string, unknown>; element?: { kind: string } }[]
    }
    expect(s.kind).toBe('intersection')
    const obj = s.parts.find(p => p.kind === 'object')
    const rec = s.parts.find(p => p.kind === 'record')
    expect(obj?.properties).toHaveProperty('name')   // declared prop validated
    expect(rec?.element?.kind).toBe('string')         // index values validated, not dropped
  })
})

// ---------------------------------------------------------------------------
// Built-in class instances
// ---------------------------------------------------------------------------

describe('built-in instances', () => {
  it('Date → instance', () => {
    expect(parseSchema(schemaOf('main.ts', 't_date'))).toEqual({ kind: 'instance', name: 'Date' })
  })
  it('Map → instance', () => {
    expect(parseSchema(schemaOf('main.ts', 't_map'))).toEqual({ kind: 'instance', name: 'Map' })
  })
  it('Set → instance', () => {
    expect(parseSchema(schemaOf('main.ts', 't_set'))).toEqual({ kind: 'instance', name: 'Set' })
  })
  it('RegExp → instance', () => {
    expect(parseSchema(schemaOf('main.ts', 't_regexp'))).toEqual({ kind: 'instance', name: 'RegExp' })
  })
  it('Uint8Array → instance', () => {
    expect(parseSchema(schemaOf('main.ts', 't_uint8'))).toEqual({ kind: 'instance', name: 'Uint8Array' })
  })
  it('a Date-typed field embeds the instance schema', () => {
    const s = parseSchema(schemaOf('main.ts', 't_date_field')) as {
      kind: string; properties: Record<string, unknown>
    }
    expect(s.properties.when).toEqual({ kind: 'instance', name: 'Date' })
    expect(s.properties.tags).toEqual({ kind: 'array', element: { kind: 'string' } })
  })
})

// ---------------------------------------------------------------------------
// String-like synthetic types & number index signatures
// ---------------------------------------------------------------------------

describe('coverage fixes', () => {
  it('template-literal type → string', () => {
    expect(parseSchema(schemaOf('main.ts', 't_tmpl'))).toEqual({ kind: 'string' })
  })
  it('{ [k: number]: string } → record (no data loss)', () => {
    expect(parseSchema(schemaOf('main.ts', 't_numidx'))).toEqual({ kind: 'record', element: { kind: 'string' } })
  })
})

// ---------------------------------------------------------------------------
// Recursive types
// ---------------------------------------------------------------------------

describe('recursive types', () => {
  it('Tree { children: Tree[] } terminates and hoists into a def with a ref', () => {
    expect(() => schemaOf('main.ts', 't_tree')).not.toThrow()
    const raw = parseSchema(schemaOf('main.ts', 't_tree')) as {
      kind: string
      defs: Record<string, { properties: Record<string, unknown> }>
      schema: { kind: string; name: string }
    }
    // Recursive types emit a def-wrapper referenced by name.
    expect(raw.kind).toBe('def')
    expect(raw.schema.kind).toBe('ref')

    const root = raw.defs[raw.schema.name]
    expect(root.properties.value).toEqual({ kind: 'string' })
    // children is an array whose element points back to the same def.
    expect(root.properties.children).toEqual({
      kind: 'array',
      element: { kind: 'ref', name: raw.schema.name },
    })
  })
})

// ---------------------------------------------------------------------------
// Schema cache
// ---------------------------------------------------------------------------

describe('schema cache', () => {
  it('returns the same string for the same TypeNode', () => {
    const cache = new Map<string, string>()
    const source = project.getSourceFileOrThrow(join(dir, 'main.ts'))
    const tn = source.getVariableDeclarationOrThrow('t_user').getTypeNode()!
    expect(typeNodeToSchema(tn, cache)).toBe(typeNodeToSchema(tn, cache))
    expect(cache.size).toBeGreaterThan(0)
  })

  it('does not collide two same-named interfaces sharing one cache', () => {
    const cache = new Map<string, string>()
    const source = project.getSourceFileOrThrow(join(dir, 'main.ts'))
    const a = source.getVariableDeclarationOrThrow('t_dup_a').getTypeNode()!
    const b = source.getVariableDeclarationOrThrow('t_dup_b').getTypeNode()!

    const sa = parseSchema(typeNodeToSchema(a, cache)) as { properties: Record<string, unknown> }
    const sb = parseSchema(typeNodeToSchema(b, cache)) as { properties: Record<string, unknown> }

    expect(sa.properties.a).toEqual({ kind: 'string' })
    expect(sa.properties.b).toBeUndefined()
    expect(sb.properties.b).toEqual({ kind: 'number' })
    expect(sb.properties.a).toBeUndefined()
  })
})
