/* eslint-disable no-console */
/**
 * The frozen `SelMask` wire format and the select-type registry (P6 / W1a,
 * plan documentation/plans/2026-08-15-0325-w1-selmask-format-migration.md §6).
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
import {FlagProperty} from '../../scripts/path.ux/scripts/path-controller/toolsys/toolprop'
import {
  _resetSelectTypesForTests,
  SelMask,
  normalizeSelMask,
  registerSelectType,
  selMaskFromNames,
  selMaskToNames,
} from '../../scripts/core/select_types'

describe('SelMask frozen bits', () => {
  afterEach(() => {
    _resetSelectTypesForTests()
  })

  test('the geometry half keeps its on-disk values', () => {
    expect(SelMask.VERTEX).toBe(1)
    expect(SelMask.EDGE).toBe(2)
    expect(SelMask.FACE).toBe(4)
    expect(SelMask.HANDLE).toBe(16)
    expect(SelMask.GEOM).toBe(7)
    expect(SelMask.SGEOM).toBe(7)
  })

  test('the object half keeps its on-disk values', () => {
    expect(SelMask.MESH).toBe(1 << 8)
    expect(SelMask.LIGHT).toBe(1 << 9)
    expect(SelMask.CAMERA).toBe(1 << 11)
    expect(SelMask.NULLOBJECT).toBe(1 << 12)
    expect(SelMask.PROCMESH).toBe(1 << 13)
    expect(SelMask.TETMESH).toBe(1 << 14)
    expect(SelMask.STRANDS).toBe(1 << 15)
  })

  test('bit 8 stays reserved so selmask=17 still means VERTEX|HANDLE', () => {
    expect(selMaskToNames(17)).toBe('VERTEX|HANDLE')
    expect(selMaskFromNames('VERTEX|HANDLE')).toBe(17)

    for (const name of Object.keys(SelMask)) {
      expect(SelMask[name]).not.toBe(8)
    }
  })
})

describe('selMaskToNames / selMaskFromNames', () => {
  afterEach(() => {
    _resetSelectTypesForTests()
  })

  test('round-trips a mixed mask', () => {
    const mask = SelMask.VERTEX | SelMask.FACE | SelMask.MESH
    expect(selMaskFromNames(selMaskToNames(mask))).toBe(mask)
  })

  test('an unnamed bit round-trips as unknown:<i>', () => {
    // 1 << 10 is a retired object type that still appears in old files.
    expect(selMaskToNames(1 << 10)).toBe('unknown:10')
    expect(selMaskFromNames('unknown:10')).toBe(1 << 10)
    expect(selMaskFromNames(selMaskToNames(SelMask.MESH | (1 << 10)))).toBe(SelMask.MESH | (1 << 10))
  })

  test('unions are not emitted in place of their member bits', () => {
    expect(selMaskToNames(SelMask.GEOM)).toBe('VERTEX|EDGE|FACE')
  })

  test('an unrecognized name is ignored, not fatal', () => {
    const warn = console.warn
    const warned: unknown[][] = []

    console.warn = (...args: unknown[]) => {
      warned.push(args)
    }

    try {
      expect(selMaskFromNames('VERTEX|NOSUCHTYPE')).toBe(SelMask.VERTEX)
    } finally {
      console.warn = warn
    }

    expect(warned.length).toBe(1)
  })

  test('the empty mask round-trips', () => {
    expect(selMaskToNames(0)).toBe('')
    expect(selMaskFromNames('')).toBe(0)
  })
})

describe('normalizeSelMask', () => {
  test('accepts the legacy int form', () => {
    expect(normalizeSelMask(17, 0)).toBe(17)
    expect(normalizeSelMask(-1, 0)).toBe(-1)
  })

  test('accepts a bare-int string (keymaps, third-party addons)', () => {
    expect(normalizeSelMask('17', 0)).toBe(17)
  })

  test('accepts the name form', () => {
    expect(normalizeSelMask('VERTEX|HANDLE', 0)).toBe(17)
  })

  test('falls back on anything else', () => {
    expect(normalizeSelMask(undefined, -1)).toBe(-1)
    expect(normalizeSelMask('', -1)).toBe(-1)
    expect(normalizeSelMask({}, 5)).toBe(5)
  })
})

describe('keymap selmask= arguments', () => {
  // `view3d.translate(selmask=...)` — the numeric form has to keep parsing
  // because user keymaps and out-of-tree addons use it.
  const prop = () => new FlagProperty('GEOM', SelMask)

  test('the numeric and name forms parse to the same mask', () => {
    expect(prop().parseArg(17)).toBe(17)
    expect(prop().parseArg('VERTEX|HANDLE')).toBe(17)
  })

  test('a single name still parses', () => {
    expect(prop().parseArg('OBJECT')).toBe(SelMask.OBJECT)
    expect(prop().parseArg('VERTEX')).toBe(SelMask.VERTEX)
  })

  test('an unknown name in a list throws', () => {
    expect(() => prop().parseArg('VERTEX|NOSUCHTYPE')).toThrow(/unknown key NOSUCHTYPE/)
  })
})

describe('select-type registry', () => {
  afterEach(() => {
    _resetSelectTypesForTests()
  })

  test('a new type gets a bit above the frozen range and joins OBJECT', () => {
    const bit = registerSelectType('LEAFMESH')

    expect(bit).toBeGreaterThanOrEqual(1 << 16)
    expect(SelMask.LEAFMESH).toBe(bit)
    expect(SelMask.OBJECT & bit).toBe(bit)
  })

  test('registration is idempotent', () => {
    expect(registerSelectType('LEAFMESH')).toBe(registerSelectType('LEAFMESH'))
  })

  test('re-registering a builtin returns its frozen bit', () => {
    expect(registerSelectType('MESH')).toBe(1 << 8)
    expect(SelMask.OBJECT & SelMask.MESH).toBe(SelMask.MESH)
  })

  test('OBJECT keeps the retired unnamed bit', () => {
    expect(SelMask.OBJECT & (1 << 10)).toBe(1 << 10)
  })

  test('a registry-allocated bit persists by name', () => {
    const bit = registerSelectType('LEAFMESH')
    const names = selMaskToNames(bit)

    expect(names).toBe('LEAFMESH')

    // The number is in-memory only: a later run may hand out a different bit,
    // and the name still resolves to whatever that run allocated.
    _resetSelectTypesForTests()
    registerSelectType('SOMETHINGELSE')
    const reallocated = registerSelectType('LEAFMESH')

    expect(reallocated).not.toBe(bit)
    expect(selMaskFromNames(names)).toBe(reallocated)
  })

  test('an &-test against OBJECT matches a newly registered type', () => {
    const bit = registerSelectType('LEAFMESH')
    expect((bit & SelMask.OBJECT) !== 0).toBe(true)
    // ...and the equality test P6 removed would not have.
    expect(bit === SelMask.OBJECT).toBe(false)
  })
})

describe('no equality test against SelMask.OBJECT survives', () => {
  // OBJECT is a derived union that grows as types register, so `=== OBJECT`
  // silently stops matching. See plan §5 step 3.
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const ROOTS = ['scripts', 'addons']
  const EQ = /[!=]==?\s*(?:SelMask\.OBJECT|OBJECT)\b|\bSelMask\.OBJECT\s*[!=]==?/

  function* walk(dir: string): Generator<string> {
    for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, ent.name)

      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'path.ux' || ent.name === 'mathl') continue
        yield* walk(p)
      } else if (/\.(ts|tsx|js|mjs)$/.test(ent.name)) {
        yield p
      }
    }
  }

  test('no source file compares a mask against OBJECT by equality', () => {
    const hits: string[] = []

    for (const r of ROOTS) {
      for (const file of walk(path.join(ROOT, r))) {
        const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)

        lines.forEach((line, i) => {
          // Prose is not code: strip line comments and jsdoc continuations.
          const code = line.replace(/\/\/.*/, '').replace(/^\s*\*.*/, '')

          if (EQ.test(code)) {
            hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`)
          }
        })
      }
    }

    expect(hits).toEqual([])
  })
})
