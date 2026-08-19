/**
 * P8 (W1c): the host's remaining *string-keyed* edges into the BREP mesh.
 *
 * These are the edges dependency-cruiser cannot see — a struct name, a toolpath
 * literal, a legacy-name table — and each one is a boot failure or a dead
 * hotkey when the mesh addon is absent. See
 * documentation/plans/2026-08-15-0335-w1-registry-hooks-and-string-key-severing.md.
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

import {jest} from '@jest/globals'

import {HotKey} from '../../scripts/path.ux/scripts/pathux'

import {
  _resetKeymapContributionsForTests,
  getKeymapEntries,
  registerKeymapEntries,
  unregisterKeymapEntries,
} from '../../scripts/core/keymap_contributions'
import {
  _resetLegacyStructNamesForTests,
  getLegacyStructNameMap,
  registerLegacyStructNames,
  unregisterLegacyStructNames,
} from '../../scripts/core/legacy_struct_migration'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(REPO_ROOT, dir)
  if (!fs.existsSync(abs)) {
    return out
  }

  for (const entry of fs.readdirSync(abs, {withFileTypes: true})) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      // path.ux is a submodule with its own rules; mathl ships a vendored build.
      if (entry.name !== 'path.ux' && entry.name !== 'node_modules' && entry.name !== 'build') {
        walk(rel, out)
      }
    } else if (/\.(ts|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(rel)
    }
  }

  return out
}

const HOST_SOURCES = walk('scripts').map((rel) => [rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')] as const)

function grep(re: RegExp): string[] {
  const hits: string[] = []

  for (const [rel, src] of HOST_SOURCES) {
    src.split('\n').forEach((line, i) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        return
      }
      if (re.test(line)) {
        hits.push(`${rel}:${i + 1}`)
      }
    })
  }

  return hits
}

describe('no string-keyed lookup of a BREP struct', () => {
  test('the host never fetches a mesh struct by nstructjs name', () => {
    expect(grep(/getStructByName\(\s*['"]mesh[.'"]/)).toEqual([])
  })

  test('the host never names a mesh struct in any nstructjs lookup', () => {
    expect(grep(/nstructjs\.\w*[Ss]truct\w*\(\s*['"]mesh\./)).toEqual([])
  })
})

describe('no addon toolpath in a host keymap', () => {
  /**
   * Toolpaths that still sit in host files, by namespace. `litemesh` is the two
   * toolmodes (`view3d/tools/boxmodel.ts`, `view3d/tools/sculptcore.ts`) that are
   * themselves awaiting extraction — the hotkey and the tool leave together, so
   * they are recorded rather than moved. Shrink this list, never grow it.
   */
  const ALLOWED_NAMESPACES = new Set(['litemesh'])

  test('no host HotKey names a mesh ToolOp', () => {
    expect(grep(/new HotKey\([^)]*['"]mesh[._]/)).toEqual([])
  })

  test('the addon namespaces still reachable from a host hotkey are the recorded ones', () => {
    const found = new Set<string>()

    for (const [, src] of HOST_SOURCES) {
      for (const m of src.matchAll(/new HotKey\([^)]*['"]([a-z_]+)\.[a-z_]+\(/g)) {
        found.add(m[1])
      }
    }

    // Host-owned namespaces are fine; only the addon-owned ones are the concern.
    const HOST_NAMESPACES = new Set([
      'app',
      'brush',
      'image',
      'view3d',
      'transform',
      'object',
      'material',
      'node',
      'scene',
      'uveditor',
      'workspace',
    ])

    expect([...found].filter((ns) => !HOST_NAMESPACES.has(ns) && !ALLOWED_NAMESPACES.has(ns))).toEqual([])
  })
})

describe('keymap contributions', () => {
  beforeEach(() => _resetKeymapContributionsForTests())

  test('a contribution appears under its keymap and leaves with its owner', () => {
    const km = {} as never

    registerKeymapEntries('view3d', 'mesh', km)
    expect(getKeymapEntries('view3d')).toEqual([km])
    expect(getKeymapEntries('node')).toEqual([])

    unregisterKeymapEntries('mesh')
    expect(getKeymapEntries('view3d')).toEqual([])
  })

  test('dispatch order follows owner id, not registration order', () => {
    const a = {id: 'a'} as never
    const z = {id: 'z'} as never

    registerKeymapEntries('view3d', 'zeta', z)
    registerKeymapEntries('view3d', 'alpha', a)

    expect(getKeymapEntries('view3d')).toEqual([a, z])
  })
})

describe('legacy struct-name migration', () => {
  beforeEach(() => _resetLegacyStructNamesForTests())

  /** Every addon whose structs used to sit in core's table. The ones P13
   * deleted or archived stay on the list: the table must not regrow them
   * either. */
  const ADDON_PREFIXES = [
    'mesh.',
    'mesh_edit.',
    'curve.',
    'tetmesh.',
    'subsurf.',
    'sculptcore.',
    'leafmesh.',
  ]

  test('the host table holds no addon-owned target', () => {
    const owned = Object.entries(getLegacyStructNameMap()).filter(([, to]) =>
      ADDON_PREFIXES.some((p) => to.startsWith(p))
    )

    expect(owned).toEqual([])
  })

  test('a contribution merges in and leaves with its owner', () => {
    registerLegacyStructNames('demo', {CotanVert: 'demo.CotanVert'})
    expect(getLegacyStructNameMap().CotanVert).toBe('demo.CotanVert')

    unregisterLegacyStructNames('demo')
    expect(getLegacyStructNameMap().CotanVert).toBeUndefined()
  })

  test('a contribution cannot shadow a host entry', () => {
    const hostEntry = Object.entries(getLegacyStructNameMap())[0]
    expect(hostEntry).toBeDefined()

    registerLegacyStructNames('rogue', {[hostEntry[0]]: 'rogue.Hijacked'})
    expect(getLegacyStructNameMap()[hostEntry[0]]).toBe(hostEntry[1])
  })
})

describe('an unbound hotkey is a no-op, not a crash', () => {
  test('a rejected execTool is logged, not left unhandled', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = {
      api: {
        execTool: () => Promise.reject(new Error('unknown tool')),
      },
    }

    expect(() => new HotKey('W', [], 'demo.vertex_smooth()').exec(ctx as never)).not.toThrow()

    // Two turns: one for execTool's rejection, one for the .catch handler.
    await Promise.resolve()
    await Promise.resolve()

    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('demo.vertex_smooth()')
  })
})
