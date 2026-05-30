import { describe, it, expect } from 'vitest'
import { __check, ValidationError, type Schema } from '../runtime/index.js'

// ---------------------------------------------------------------------------
// ValidationError shape
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('is an instance of Error', () => {
    expect(() => __check(42, { kind: 'string' })).toThrow(Error)
  })

  it('name is ValidationError', () => {
    try { __check(42, { kind: 'string' }) } catch (e) {
      expect((e as Error).name).toBe('ValidationError')
    }
  })

  it('message is prefixed with [t12n]', () => {
    try { __check(42, { kind: 'string' }) } catch (e) {
      expect((e as Error).message).toMatch(/^\[t12n\]/)
    }
  })

  it('exposes path / expected / received / issues', () => {
    try { __check(42, { kind: 'string' }) } catch (e) {
      const ve = e as ValidationError
      expect(ve.path).toBe('(root)')
      expect(ve.expected).toBe('string')
      expect(ve.received).toBe(42)
      expect(Array.isArray(ve.issues)).toBe(true)
    }
  })

  it('does not throw on circular reference in received value', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => __check(circular, { kind: 'string' })).toThrow(ValidationError)
  })

  it('does not crash on BigInt received', () => {
    expect(() => __check(42n, { kind: 'string' })).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe('string', () => {
  const S: Schema = { kind: 'string' }
  it('accepts a string', () => expect(__check('a', S)).toBe('a'))
  it('accepts empty string', () => expect(__check('', S)).toBe(''))
  it('rejects a number', () => expect(() => __check(42, S)).toThrow(ValidationError))
  it('rejects undefined', () => expect(() => __check(undefined, S)).toThrow(ValidationError))
  it('rejects null', () => expect(() => __check(null, S)).toThrow(ValidationError))
  it('rejects a String object', () => expect(() => __check(new String('a'), S)).toThrow(ValidationError))
})

describe('number', () => {
  const S: Schema = { kind: 'number' }
  it('accepts integer', () => expect(__check(42, S)).toBe(42))
  it('accepts float', () => expect(__check(3.14, S)).toBe(3.14))
  it('accepts negative', () => expect(__check(-1, S)).toBe(-1))
  it('accepts 0', () => expect(__check(0, S)).toBe(0))
  it('accepts Infinity', () => expect(__check(Infinity, S)).toBe(Infinity))
  it('rejects NaN', () => expect(() => __check(NaN, S)).toThrow(ValidationError))
  it('rejects string', () => expect(() => __check('42', S)).toThrow(ValidationError))
  it('rejects bigint', () => expect(() => __check(42n, S)).toThrow(ValidationError))
})

describe('boolean', () => {
  const S: Schema = { kind: 'boolean' }
  it('accepts true', () => expect(__check(true, S)).toBe(true))
  it('accepts false', () => expect(__check(false, S)).toBe(false))
  it('rejects 1', () => expect(() => __check(1, S)).toThrow(ValidationError))
  it('rejects "true"', () => expect(() => __check('true', S)).toThrow(ValidationError))
})

describe('bigint / null / undefined / void', () => {
  it('bigint accepts 42n', () => expect(__check(42n, { kind: 'bigint' })).toBe(42n))
  it('null accepts null only', () => {
    expect(__check(null, { kind: 'null' })).toBe(null)
    expect(() => __check(undefined, { kind: 'null' })).toThrow(ValidationError)
  })
  it('undefined accepts undefined only', () => {
    expect(__check(undefined, { kind: 'undefined' })).toBe(undefined)
    expect(() => __check(null, { kind: 'undefined' })).toThrow(ValidationError)
  })
  it('void accepts undefined', () => {
    expect(__check(undefined, { kind: 'void' })).toBe(undefined)
  })
})

describe('any / unknown / never', () => {
  it('any accepts anything', () => {
    expect(__check(1, { kind: 'any' })).toBe(1)
    expect(__check('a', { kind: 'any' })).toBe('a')
    expect(__check(null, { kind: 'any' })).toBe(null)
  })
  it('unknown accepts anything', () => {
    expect(__check({}, { kind: 'unknown' })).toEqual({})
  })
  it('never rejects everything', () => {
    expect(() => __check(undefined, { kind: 'never' })).toThrow(ValidationError)
    expect(() => __check(0, { kind: 'never' })).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Literals & enums
// ---------------------------------------------------------------------------

describe('literal', () => {
  it('matches exact string', () => {
    expect(__check('hello', { kind: 'literal', value: 'hello' })).toBe('hello')
  })
  it('rejects different string', () => {
    expect(() => __check('world', { kind: 'literal', value: 'hello' })).toThrow(ValidationError)
  })
  it('matches exact number', () => {
    expect(__check(42, { kind: 'literal', value: 42 })).toBe(42)
  })
  it('matches true literal', () => {
    expect(__check(true, { kind: 'literal', value: true })).toBe(true)
  })
  it('rejects type-coercion', () => {
    expect(() => __check('42', { kind: 'literal', value: 42 })).toThrow(ValidationError)
  })
})

describe('enum', () => {
  const S: Schema = { kind: 'enum', values: ['a', 'b', 'c'] }
  it('accepts a member', () => expect(__check('b', S)).toBe('b'))
  it('rejects non-member', () => expect(() => __check('d', S)).toThrow(ValidationError))
  it('rejects non-string', () => expect(() => __check(1, S)).toThrow(ValidationError))
})

// ---------------------------------------------------------------------------
// Arrays & tuples
// ---------------------------------------------------------------------------

describe('array', () => {
  const S: Schema = { kind: 'array', element: { kind: 'number' } }
  it('accepts empty array', () => expect(__check([], S)).toEqual([]))
  it('accepts array of numbers', () => expect(__check([1, 2, 3], S)).toEqual([1, 2, 3]))
  it('rejects array with wrong element', () => {
    expect(() => __check([1, 'two', 3], S)).toThrow(ValidationError)
  })
  it('rejects non-array', () => {
    expect(() => __check('not array', S)).toThrow(ValidationError)
  })
  it('error path includes the bad index', () => {
    try { __check([1, 'two', 3], S) } catch (e) {
      expect((e as ValidationError).path).toBe('1')
    }
  })
})

describe('tuple', () => {
  const S: Schema = { kind: 'tuple', elements: [{ kind: 'string' }, { kind: 'number' }] }
  it('accepts matching shape', () => expect(__check(['a', 1], S)).toEqual(['a', 1]))
  it('rejects wrong length (shorter)', () => {
    expect(() => __check(['a'], S)).toThrow(ValidationError)
  })
  it('rejects wrong length (longer)', () => {
    expect(() => __check(['a', 1, 'extra'], S)).toThrow(ValidationError)
  })
  it('rejects wrong element type', () => {
    expect(() => __check(['a', 'b'], S)).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

describe('object', () => {
  const S: Schema = {
    kind: 'object',
    properties: {
      id: { kind: 'number' },
      name: { kind: 'string' },
    },
  }

  it('accepts a matching object', () => {
    expect(__check({ id: 1, name: 'A' }, S)).toEqual({ id: 1, name: 'A' })
  })

  it('strips unknown keys by default', () => {
    expect(__check({ id: 1, name: 'A', extra: true }, S)).toEqual({ id: 1, name: 'A' })
  })

  it('rejects when required key is missing', () => {
    expect(() => __check({ id: 1 }, S)).toThrow(ValidationError)
  })

  it('error path points to the missing field', () => {
    try { __check({ id: 1 }, S) } catch (e) {
      expect((e as ValidationError).path).toBe('name')
    }
  })

  it('rejects when a value is the wrong type', () => {
    expect(() => __check({ id: 'bad', name: 'A' }, S)).toThrow(ValidationError)
  })

  it('rejects null', () => {
    expect(() => __check(null, S)).toThrow(ValidationError)
  })

  it('rejects array', () => {
    expect(() => __check([], S)).toThrow(ValidationError)
  })
})

describe('object with optional list', () => {
  const S: Schema = {
    kind: 'object',
    properties: {
      id: { kind: 'number' },
      nickname: { kind: 'string' },
    },
    optional: ['nickname'],
  }

  it('accepts when optional key is omitted', () => {
    expect(__check({ id: 1 }, S)).toEqual({ id: 1 })
  })

  it('accepts when optional key is present and valid', () => {
    expect(__check({ id: 1, nickname: 'A' }, S)).toEqual({ id: 1, nickname: 'A' })
  })

  it('rejects when optional key has a wrong type', () => {
    expect(() => __check({ id: 1, nickname: 99 }, S)).toThrow(ValidationError)
  })
})

describe('object with optional<T> field schema', () => {
  const S: Schema = {
    kind: 'object',
    properties: {
      id: { kind: 'number' },
      email: { kind: 'optional', inner: { kind: 'string' } },
    },
  }

  it('accepts missing email', () => {
    expect(__check({ id: 1 }, S)).toEqual({ id: 1 })
  })

  it('accepts email: undefined', () => {
    expect(__check({ id: 1, email: undefined }, S)).toEqual({ id: 1 })
  })

  it('accepts email: string', () => {
    expect(__check({ id: 1, email: 'a' }, S)).toEqual({ id: 1, email: 'a' })
  })

  it('rejects email: number', () => {
    expect(() => __check({ id: 1, email: 42 }, S)).toThrow(ValidationError)
  })
})

describe('nested objects', () => {
  const S: Schema = {
    kind: 'object',
    properties: {
      user: {
        kind: 'object',
        properties: { address: { kind: 'object', properties: { zip: { kind: 'string' } } } },
      },
    },
  }

  it('nested error has dotted path', () => {
    try { __check({ user: { address: { zip: 123 } } }, S) } catch (e) {
      expect((e as ValidationError).path).toBe('user.address.zip')
    }
  })
})

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

describe('record', () => {
  const S: Schema = { kind: 'record', element: { kind: 'number' } }
  it('accepts empty object', () => expect(__check({}, S)).toEqual({}))
  it('accepts arbitrary keys with number values', () => {
    expect(__check({ a: 1, b: 2 }, S)).toEqual({ a: 1, b: 2 })
  })
  it('rejects on wrong value type', () => {
    expect(() => __check({ a: 'x' }, S)).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

describe('union', () => {
  const S: Schema = {
    kind: 'union',
    options: [{ kind: 'string' }, { kind: 'number' }],
  }
  it('accepts string', () => expect(__check('a', S)).toBe('a'))
  it('accepts number', () => expect(__check(1, S)).toBe(1))
  it('rejects boolean', () => expect(() => __check(true, S)).toThrow(ValidationError))

  it('picks the deepest-path failure for diagnostics', () => {
    const complex: Schema = {
      kind: 'union',
      options: [
        { kind: 'object', properties: { type: { kind: 'literal', value: 'a' }, a: { kind: 'string' } } },
        { kind: 'object', properties: { type: { kind: 'literal', value: 'b' }, b: { kind: 'number' } } },
      ],
    }
    try {
      __check({ type: 'b', b: 'wrong' }, complex)
    } catch (e) {
      const ve = e as ValidationError
      // Should mention path 'b' from the matching-discriminator branch, not just (root)
      expect(ve.issues.some(i => i.nested?.some(n => n.path === 'b'))).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Intersections
// ---------------------------------------------------------------------------

describe('intersection', () => {
  const S: Schema = {
    kind: 'intersection',
    parts: [
      { kind: 'object', properties: { a: { kind: 'string' } } },
      { kind: 'object', properties: { b: { kind: 'number' } } },
    ],
  }

  it('accepts object satisfying both parts', () => {
    expect(__check({ a: 'x', b: 1 }, S)).toEqual({ a: 'x', b: 1 })
  })

  it('rejects when one part fails', () => {
    expect(() => __check({ a: 'x' }, S)).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

describe('nullable', () => {
  const S: Schema = { kind: 'nullable', inner: { kind: 'string' } }
  it('accepts null', () => expect(__check(null, S)).toBe(null))
  it('accepts string', () => expect(__check('a', S)).toBe('a'))
  it('rejects undefined', () => expect(() => __check(undefined, S)).toThrow(ValidationError))
})

describe('optional (top-level)', () => {
  const S: Schema = { kind: 'optional', inner: { kind: 'string' } }
  it('accepts undefined', () => expect(__check(undefined, S)).toBe(undefined))
  it('accepts string', () => expect(__check('a', S)).toBe('a'))
  it('rejects null', () => expect(() => __check(null, S)).toThrow(ValidationError))
})

// ---------------------------------------------------------------------------
// Complex real-world-ish shape
// ---------------------------------------------------------------------------

describe('complex shape', () => {
  const User: Schema = {
    kind: 'object',
    properties: {
      id: { kind: 'number' },
      name: { kind: 'string' },
      email: { kind: 'optional', inner: { kind: 'string' } },
      role: { kind: 'enum', values: ['admin', 'user', 'guest'] },
      tags: { kind: 'array', element: { kind: 'string' } },
      address: {
        kind: 'nullable',
        inner: {
          kind: 'object',
          properties: { city: { kind: 'string' }, zip: { kind: 'string' } },
        },
      },
    },
  }

  it('accepts a full valid user', () => {
    const ok = {
      id: 1, name: 'A', email: 'a@b', role: 'admin',
      tags: ['x', 'y'], address: { city: 'NYC', zip: '10001' },
    }
    expect(__check(ok, User)).toEqual(ok)
  })

  it('accepts user with omitted email and null address', () => {
    const ok = { id: 1, name: 'A', role: 'guest', tags: [], address: null }
    expect(__check(ok, User)).toEqual(ok)
  })

  it('points path at deep failure', () => {
    try {
      __check({
        id: 1, name: 'A', role: 'admin', tags: ['x'],
        address: { city: 'NYC', zip: 99999 },
      }, User)
    } catch (e) {
      expect((e as ValidationError).path).toBe('address.zip')
    }
  })

  it('points path at bad array index', () => {
    try {
      __check({
        id: 1, name: 'A', role: 'admin', tags: ['ok', 42, 'ok'],
        address: null,
      }, User)
    } catch (e) {
      expect((e as ValidationError).path).toBe('tags.1')
    }
  })

  it('rejects unknown enum value', () => {
    expect(() => __check({
      id: 1, name: 'A', role: 'super', tags: [], address: null,
    }, User)).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Recursive types (def / ref wire format → materialize)
// ---------------------------------------------------------------------------

describe('recursive schema (def/ref)', () => {
  // Mirrors what the plugin emits for: interface Tree { value: string; children: Tree[] }
  const Tree = {
    kind: 'def',
    defs: {
      t0: {
        kind: 'object',
        properties: {
          value: { kind: 'string' },
          children: { kind: 'array', element: { kind: 'ref', name: 't0' } },
        },
      },
    },
    schema: { kind: 'ref', name: 't0' },
  } as unknown as Schema

  it('accepts a deeply nested valid tree', () => {
    const value = {
      value: 'root',
      children: [
        { value: 'a', children: [] },
        { value: 'b', children: [{ value: 'b1', children: [] }] },
      ],
    }
    expect(() => __check(value, Tree)).not.toThrow()
  })

  it('rejects a deep mismatch and reports the nested path', () => {
    const value = {
      value: 'root',
      children: [{ value: 'a', children: [{ value: 123, children: [] }] }],
    }
    try {
      __check(value, Tree)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as ValidationError).path).toBe('children.0.children.0.value')
    }
  })

  it('handles mutually recursive defs', () => {
    // interface A { b?: B }  interface B { a?: A }
    const AB = {
      kind: 'def',
      defs: {
        a: { kind: 'object', properties: { b: { kind: 'ref', name: 'b' } }, optional: ['b'] },
        b: { kind: 'object', properties: { a: { kind: 'ref', name: 'a' } }, optional: ['a'] },
      },
      schema: { kind: 'ref', name: 'a' },
    } as unknown as Schema

    expect(() => __check({ b: { a: { b: {} } } }, AB)).not.toThrow()
    expect(() => __check({ b: { a: { b: { a: 5 } } } }, AB)).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Built-in instances
// ---------------------------------------------------------------------------

describe('instance', () => {
  const dateSchema: Schema = { kind: 'instance', name: 'Date' }

  it('accepts a matching instance and returns it unchanged (no strip)', () => {
    const d = new Date()
    expect(__check(d, dateSchema)).toBe(d)
  })

  it('rejects a non-instance', () => {
    expect(() => __check('2024-01-01', dateSchema)).toThrow(ValidationError)
    expect(() => __check({}, dateSchema)).toThrow(ValidationError)
  })

  it('rejects a different built-in', () => {
    expect(() => __check(new Map(), dateSchema)).toThrow(ValidationError)
  })

  it('validates instances nested in an object without mangling them', () => {
    const schema: Schema = {
      kind: 'object',
      properties: { when: { kind: 'instance', name: 'Date' }, id: { kind: 'number' } },
    }
    const d = new Date()
    const out = __check({ when: d, id: 1, extra: 'x' }, schema) as { when: Date; id: number }
    expect(out.when).toBe(d) // same Date reference, not coerced/stripped
    expect(out.id).toBe(1)
    expect('extra' in out).toBe(false) // unknown key still stripped
  })

  it('reports the constructor name as the expected type', () => {
    try { __check(42, dateSchema) } catch (e) {
      expect((e as ValidationError).expected).toBe('Date')
    }
  })
})

// ---------------------------------------------------------------------------
// Error site — source location & boundary (embedded by the plugin)
// ---------------------------------------------------------------------------

describe('error site', () => {
  // The plugin emits the compact wire meta `{at, b}` (vite/index.ts). The runtime
  // must expand it onto ValidationError.source/.boundary — these keys are a
  // contract between the two halves, so the test uses the exact emitted shape.
  it('carries source + boundary and shows them in the message', () => {
    try {
      __check(42, { kind: 'string' }, '(root)', { at: 'src/App.vue:42', b: 'fetch().json()' })
    } catch (e) {
      const ve = e as import('../runtime/index.js').ValidationError & { source?: string; boundary?: string }
      expect(ve.source).toBe('src/App.vue:42')
      expect(ve.boundary).toBe('fetch().json()')
      expect(ve.message).toContain('src/App.vue:42')
      expect(ve.message).toContain('fetch().json()')
    }
  })

  it('works without a site (source/boundary undefined)', () => {
    try {
      __check(42, { kind: 'string' })
    } catch (e) {
      const ve = e as ValidationError & { source?: string; boundary?: string }
      expect(ve.source).toBeUndefined()
      expect(ve.boundary).toBeUndefined()
      expect(ve.message).toMatch(/^\[t12n\]/)
    }
  })
})

// ---------------------------------------------------------------------------
// Collect-all — one boundary, one error, every failing field in `issues`
// ---------------------------------------------------------------------------

describe('collect-all issues', () => {
  const user: Schema = {
    kind: 'object',
    properties: {
      id: { kind: 'string' },
      email: { kind: 'string' },
      age: { kind: 'number' },
    },
  }

  it('gathers every bad field of one object into issues[]', () => {
    try {
      __check({ id: 1, email: null, age: '20' }, user)
      throw new Error('should have thrown')
    } catch (e) {
      const ve = e as ValidationError
      expect(ve).toBeInstanceOf(ValidationError)
      const paths = ve.issues.map(i => i.path).sort()
      expect(paths).toEqual(['age', 'email', 'id'])
    }
  })

  it('one throw, message lists all issues with a count', () => {
    try {
      __check({ id: 1, email: null, age: '20' }, user)
    } catch (e) {
      const ve = e as ValidationError
      expect(ve.message).toContain('3 issues')
      expect(ve.message).toContain('id')
      expect(ve.message).toContain('email')
      expect(ve.message).toContain('age')
    }
  })

  it('collects across nested objects with full dotted paths', () => {
    const schema: Schema = {
      kind: 'object',
      properties: {
        name: { kind: 'string' },
        address: { kind: 'object', properties: { zip: { kind: 'string' }, city: { kind: 'string' } } },
      },
    }
    try {
      __check({ name: 2, address: { zip: 5, city: 'x' } }, schema)
    } catch (e) {
      const paths = (e as ValidationError).issues.map(i => i.path).sort()
      expect(paths).toEqual(['address.zip', 'name'])
    }
  })

  it('still reports a single issue as one', () => {
    try {
      __check({ id: 'ok', email: 'a@b.c', age: '20' }, user)
    } catch (e) {
      const ve = e as ValidationError
      expect(ve.issues).toHaveLength(1)
      expect(ve.issues[0].path).toBe('age')
      expect(ve.message).not.toContain('issues') // singular format
    }
  })
})
