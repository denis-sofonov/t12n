import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  __guard,
  __check,
  configure,
  ValidationError,
  type Schema,
  type ViolationContext,
} from '../runtime/index.js'

// The violation handler is global state — reset after every test so cases
// don't leak into one another (and so the default "throw" behaviour holds
// for the rest of the suite).
afterEach(() => configure({ onViolation: null }))

const USER: Schema = {
  kind: 'object',
  properties: {
    id:   { kind: 'number' },
    name: { kind: 'string' },
    tags: { kind: 'array', element: { kind: 'string' } },
    address: {
      kind: 'object',
      properties: { zip: { kind: 'string' } },
    },
  },
}

describe('guard — initial validation', () => {
  it('returns a usable object for valid data', () => {
    const u = __guard<{ id: number; name: string }>(
      { id: 1, name: 'a', tags: [], address: { zip: '1' } },
      USER,
    )
    expect(u.id).toBe(1)
    expect(u.name).toBe('a')
  })

  it('throws on invalid initial shape (default handler)', () => {
    expect(() => __guard({ id: 'nope', name: 'a', tags: [], address: { zip: '1' } }, USER))
      .toThrow(ValidationError)
  })
})

describe('guard — live mutation traps', () => {
  const make = () => __guard<any>(
    { id: 1, name: 'a', tags: ['x'], address: { zip: '1' } },
    USER,
  )

  it('rejects an off-type write to a known property', () => {
    const u = make()
    expect(() => { u.id = 'twenty' }).toThrow(ValidationError)
  })

  it('reports the correct path on a bad write', () => {
    const u = make()
    try { u.id = 'twenty' } catch (e) {
      expect((e as ValidationError).path).toBe('id')
    }
  })

  it('allows an in-type write', () => {
    const u = make()
    u.id = 2
    expect(u.id).toBe(2)
  })

  it('catches drift on a nested object', () => {
    const u = make()
    expect(() => { u.address.zip = 123 }).toThrow(ValidationError)
  })

  it('reports the nested path', () => {
    const u = make()
    try { u.address.zip = 123 } catch (e) {
      expect((e as ValidationError).path).toBe('address.zip')
    }
  })

  it('catches a bad array element write', () => {
    const u = make()
    expect(() => { u.tags[0] = 99 }).toThrow(ValidationError)
  })

  it('catches a bad push onto a guarded array', () => {
    const u = make()
    expect(() => { u.tags.push(99) }).toThrow(ValidationError)
  })

  it('allows a valid push', () => {
    const u = make()
    u.tags.push('y')
    expect(u.tags).toEqual(['x', 'y'])
  })

  it('rejects writing a property not declared on the type', () => {
    const u = make()
    expect(() => { u.surprise = 1 }).toThrow(ValidationError)
  })

  it('rejects deleting a required property', () => {
    const u = make()
    expect(() => { delete u.id }).toThrow(ValidationError)
  })

  it('preserves identity across nested reads', () => {
    const u = make()
    expect(u.address).toBe(u.address)
  })
})

describe('onViolation handler', () => {
  it('boundary failure passes the value through when handler does not throw', () => {
    const seen: ViolationContext[] = []
    configure({ onViolation: (ctx) => { seen.push(ctx) } })

    const bad = { id: 'x', name: 'a', tags: [], address: { zip: '1' } }
    const out = __guard<any>(bad, USER)

    expect(seen).toHaveLength(1)
    expect(seen[0].site).toBe('boundary')
    expect(seen[0].path).toBe('id')
    // App keeps running with the raw value.
    expect(out.name).toBe('a')
  })

  it('mutation is applied and reported when handler does not throw', () => {
    const handler = vi.fn()
    configure({ onViolation: handler })

    const u = __guard<any>({ id: 1, name: 'a', tags: [], address: { zip: '1' } }, USER)
    u.id = 'drift'

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].site).toBe('mutation')
    expect(handler.mock.calls[0][0].path).toBe('id')
    // Write went through because the handler chose not to abort.
    expect(u.id).toBe('drift')
  })

  it('re-throwing inside the handler aborts as before', () => {
    configure({ onViolation: (ctx) => { throw ctx.error } })
    expect(() => __check(42, { kind: 'string' })).toThrow(ValidationError)
  })

  it('configure({ onViolation: null }) restores throwing default', () => {
    configure({ onViolation: () => {} })
    expect(() => __check(42, { kind: 'string' })).not.toThrow()
    configure({ onViolation: null })
    expect(() => __check(42, { kind: 'string' })).toThrow(ValidationError)
  })

  it('check passes through the raw value under a non-throwing handler', () => {
    configure({ onViolation: () => {} })
    expect(__check<number>('not a number' as unknown as number, { kind: 'number' }))
      .toBe('not a number')
  })
})

describe('guard — union & intersection live-wrapping', () => {
  const Shape = {
    kind: 'union',
    options: [
      { kind: 'object', properties: { t: { kind: 'literal', value: 'a' }, n: { kind: 'number' } } },
      { kind: 'object', properties: { t: { kind: 'literal', value: 'b' }, s: { kind: 'string' } } },
    ],
  } as unknown as Schema

  it('guards the branch the value actually matches', () => {
    const v = __guard<any>({ t: 'a', n: 1 }, Shape)
    v.n = 2
    expect(v.n).toBe(2)
    expect(() => { v.n = 'nope' }).toThrow(ValidationError)
  })

  it('guards a merged intersection of objects', () => {
    const AB = {
      kind: 'intersection',
      parts: [
        { kind: 'object', properties: { a: { kind: 'string' } } },
        { kind: 'object', properties: { b: { kind: 'number' } } },
      ],
    } as unknown as Schema
    const v = __guard<any>({ a: 'x', b: 1 }, AB)
    expect(() => { v.a = 5 }).toThrow(ValidationError)
    expect(() => { v.b = 'y' }).toThrow(ValidationError)
    v.b = 2
    expect(v.b).toBe(2)
  })
})
