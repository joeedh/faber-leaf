/**
 * Pins the host geometry contract's shared vocabulary and its "ask the registry,
 * never the type" rule. See documentation/geometry-contract.md.
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

import {AttrType as LeafAttrType, DOMAIN_COUNT, Domain} from '../../addons/builtin/leafmesh/src/attrs'
import {
  ELEMENT_DOMAIN_COUNT,
  ElementDomain,
  GeometryCapability,
  AttrType,
  InvalidationKind,
  asElementSource,
  asInvalidatable,
  hasCapability,
  resolveKindId,
} from '../../scripts/core/geometry_contract'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The vocabulary is declared three times: here, in the attribute layers, and
 * in the engine, because core cannot import an addon and the addon cannot
 * import the engine's headers. The three declarations must stay numerically
 * identical, so a layer round-trips as a column copy rather than a
 * conversion.
 */
describe('shared vocabulary', () => {
  test('element domains match the attribute-layer domains', () => {
    expect(ElementDomain.VERT).toBe(Domain.VERT)
    expect(ElementDomain.EDGE).toBe(Domain.EDGE)
    expect(ElementDomain.CORNER).toBe(Domain.CORNER)
    expect(ElementDomain.LOOP).toBe(Domain.LOOP)
    expect(ElementDomain.FACE).toBe(Domain.FACE)
    expect(ELEMENT_DOMAIN_COUNT).toBe(DOMAIN_COUNT)
  })

  test('attribute types match the attribute-layer types, name for name', () => {
    const names = Object.keys(LeafAttrType).filter((k) => isNaN(Number(k)))
    expect(names.length).toBeGreaterThan(0)

    for (const name of names) {
      expect(`${name}=${(AttrType as Record<string, unknown>)[name]}`).toBe(
        `${name}=${(LeafAttrType as Record<string, unknown>)[name]}`
      )
    }

    // Neither side may grow a member the other lacks.
    expect(
      Object.keys(AttrType)
        .filter((k) => isNaN(Number(k)))
        .sort()
    ).toEqual(names.sort())
  })

  test('invalidation kinds are disjoint bits and ALL is their union', () => {
    const bits = [
      InvalidationKind.TOPOLOGY,
      InvalidationKind.POSITIONS,
      InvalidationKind.ATTRIBUTES,
      InvalidationKind.SELECTION,
      InvalidationKind.MATERIALS,
    ]

    for (const bit of bits) {
      expect(bit & (bit - 1)).toBe(0)
    }
    expect(new Set(bits).size).toBe(bits.length)
    expect(bits.reduce((a, b) => a | b, 0)).toBe(InvalidationKind.ALL)
  })
})

/**
 * `SceneObjectData.dataKindOf` delegates here, so this is the only copy of
 * the rule. These tests exercise it without importing the base class,
 * because that class pulls in path.ux at module load and cannot run in a
 * bare-node suite.
 */
describe('resolveKindId', () => {
  test('prefers dataKind, falls back to a lowercased name', () => {
    class Tagged {
      static dataDefine() {
        return {dataKind: 'litemesh', name: 'LiteMesh'}
      }
    }
    class Untagged {
      static dataDefine() {
        return {name: 'LeafMesh'}
      }
    }

    expect(resolveKindId(new Tagged())).toBe('litemesh')
    expect(resolveKindId(new Untagged())).toBe('leafmesh')
  })

  test('caches on the constructor and tolerates a type that has no dataDefine', () => {
    let calls = 0
    class Counted {
      static dataDefine() {
        calls++
        return {dataKind: 'imaginary'}
      }
    }

    expect(resolveKindId(new Counted())).toBe('imaginary')
    expect(resolveKindId(new Counted())).toBe('imaginary')
    expect(calls).toBe(1)

    expect(resolveKindId({})).toBeUndefined()
    expect(resolveKindId(undefined)).toBeUndefined()
  })
})

describe('capability narrowing', () => {
  const impl = {
    topoStamp: 0,
    invalidate() {},
  }

  test('an undeclared capability does not narrow, even when the methods are there', () => {
    expect(asInvalidatable(impl, {})).toBeUndefined()
    expect(hasCapability({}, GeometryCapability.INVALIDATION)).toBe(false)
  })

  test('declaring the capability is what routes the call', () => {
    const kind = {capabilities: [GeometryCapability.INVALIDATION]}
    expect(asInvalidatable(impl, kind)).toBe(impl)
    expect(asElementSource(impl, kind)).toBeUndefined()
  })

  test('a missing instance never narrows', () => {
    const kind = {capabilities: [GeometryCapability.INVALIDATION]}
    expect(asInvalidatable(undefined, kind)).toBeUndefined()
  })
})

/**
 * §11: the host must not branch on a concrete geometry type. This is a grep, not
 * a typecheck, because the patterns it catches all typecheck fine.
 */
describe('no concrete-type branching in the host', () => {
  const DIRS = [
    'scripts/core',
    'scripts/scene',
    'scripts/sceneobject',
    'scripts/editors/view3d/transform',
    'scripts/editors/properties',
  ]

  const PATTERNS: [string, RegExp][] = [
    ['instanceof Mesh', /\binstanceof\s+(Wasm)?Mesh\b/],
    ['instanceof LiteMesh', /\binstanceof\s+LiteMesh\b/],
    ["type === 'mesh'", /\.type\s*===\s*['"]mesh['"]/],
    ['kind-string compare', /dataKindOf\([^)]*\)\s*[!=]==\s*['"]/],
    // §5: the nine-name regen vocabulary collapsed onto `invalidate`. A host
    // call to any of them is a provider-specific method name leaking back.
    [
      'regen* invalidation',
      /\.(regenRender|regenTessellation|regenPartial|regenBVH|regenElementsDraw|regenAll|regenUVEditor|regenUVWrangler)\s*\(/,
    ],
  ]

  /**
   * Empty since P13: the last three kind-string compares were context.ts's, and
   * they went with the BREP. Shrink this list, never grow it — a new entry means
   * the host learned a type name.
   */
  const ALLOWED = new Set<string>([])

  /**
   * Blank out `/* … *\/` bodies, keeping the line count so reported line numbers
   * still point at the file. Commented-out code is not a host branch, and these
   * files carry a lot of it.
   */
  function stripBlockComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
  }

  function walk(dir: string, out: string[] = []): string[] {
    const abs = path.join(REPO_ROOT, dir)
    if (!fs.existsSync(abs)) {
      return out
    }
    for (const entry of fs.readdirSync(abs, {withFileTypes: true})) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(rel, out)
      } else if (/\.(ts|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        out.push(rel)
      }
    }
    return out
  }

  test('the known-clean directories stay clean', () => {
    const hits: string[] = []
    const seen = new Set<string>()

    for (const dir of DIRS) {
      for (const rel of walk(dir)) {
        const src = stripBlockComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
        src.split('\n').forEach((line, i) => {
          if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) {
            return
          }
          for (const [label, re] of PATTERNS) {
            if (!re.test(line)) {
              continue
            }
            const hit = `${rel}:${i + 1}: ${label}`
            seen.add(hit)
            if (!ALLOWED.has(hit)) {
              hits.push(hit)
            }
          }
        })
      }
    }

    expect(hits).toEqual([])

    // A stale allowance is a silent hole: the line moved and stopped being checked.
    expect([...ALLOWED].filter((a) => !seen.has(a))).toEqual([])
  })
})
