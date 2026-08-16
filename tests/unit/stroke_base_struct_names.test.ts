/**
 * Serialization guard for the P4 stroke-base hoist.
 *
 * `PaintSample`, `PaintSampleProperty`, `BrushProperty` and `PaintToolModeBase`
 * moved out of `pbvh_base.ts` / `pbvh_paintsample.ts` and into `stroke_base.ts`.
 * nstructjs keys off the struct name, not the module path, so a pure file move
 * is invisible to the format — but only as long as nobody renames a struct or
 * drops a field on the way past. Any .wproj saved with `save_toolstack` set
 * carries these four on disk; `examples/brush_asymmetric_toolstack.wproj` is
 * the committed one.
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WPROJ = path.join(ROOT, 'examples', 'brush_asymmetric_toolstack.wproj')
const STROKE_BASE = path.join(ROOT, 'scripts', 'editors', 'view3d', 'tools', 'stroke_base.ts')

/** The hoisted classes, each with the struct it inherits its leading fields from. */
const HOISTED: ReadonlyArray<readonly [string, string | null]> = [
  ['PaintSample', null],
  ['PaintSampleProperty', 'ToolProperty'],
  ['BrushProperty', 'ToolProperty'],
  ['PaintToolModeBase', 'ToolMode'],
]

/**
 * A .wproj opens with `WPRJ`, a u32 version, a u32 schema byte-length, then the
 * nstructjs schema as text. Only the header is read — the file is ~23MB.
 */
function readSchema(): string {
  const fd = fs.openSync(WPROJ, 'r')
  try {
    const head = Buffer.alloc(12)
    fs.readSync(fd, head, 0, 12, 0)
    expect(head.slice(0, 4).toString('latin1')).toBe('WPRJ')

    const len = head.readUInt32LE(8)
    const schema = Buffer.alloc(len)
    fs.readSync(fd, schema, 0, len, 12)
    return schema.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** `Name id=N { ... }` blocks, mapped to their field-name lists. */
function parseStructs(schema: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of schema.matchAll(/^([\w.]+) id=\d+ \{\n([\s\S]*?)\n\}/gm)) {
    out.set(m[1], fieldNames(m[2]))
  }
  return out
}

function fieldNames(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(/[\s:]/)[0])
}

/** The struct bodies `nstructjs.inlineRegister` declares in a source file. */
function parseInlineRegisters(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of src.matchAll(/inlineRegister\(\s*this,\s*`\s*([\w.]+)\s*\{\r?\n([\s\S]*?)\r?\n\s*\}`/g)) {
    out.set(m[1], fieldNames(m[2]))
  }
  return out
}

describe('stroke_base struct names survive the hoist', () => {
  const onDisk = parseStructs(readSchema())
  const declared = parseInlineRegisters(fs.readFileSync(STROKE_BASE, 'utf8'))

  test('the example toolstack really does carry all four structs', () => {
    for (const [name] of HOISTED) {
      expect(onDisk.has(name)).toBe(true)
    }
  })

  test('stroke_base.ts declares each one under its original name', () => {
    for (const [name] of HOISTED) {
      expect(declared.has(name)).toBe(true)
    }
  })

  test.each(HOISTED.map(([name, base]) => [name, base] as const))(
    'every %s field on disk still exists in the source struct',
    (name, base) => {
      const inherited = new Set(base === null ? [] : onDisk.get(base) ?? [])
      expect(base === null || inherited.size > 0).toBe(true)

      const own = (onDisk.get(name) ?? []).filter((f) => !inherited.has(f))
      expect(own.length).toBeGreaterThan(0)

      const source = new Set(declared.get(name) ?? [])
      // A field may be added since the file was written, never dropped — the
      // reader has to have somewhere to put every value the file carries.
      expect(own.filter((f) => !source.has(f))).toEqual([])
    }
  )
})
