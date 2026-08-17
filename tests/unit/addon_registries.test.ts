/**
 * The non-class registries `AddonAPI` gained in P7 (§9 of
 * documentation/geometry-contract.md), plus the property that makes them worth
 * having: everything registered through the API can be unregistered.
 *
 * The registries are exercised directly. `AddonAPI` itself cannot be imported
 * here — `addon_base.ts` pulls path.ux, the shader stack and `_appstate` in at
 * module load — so its wiring is checked against the source instead, which is
 * enough to catch the failure that actually happens: a `register*` case added
 * without its undo.
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

import {
  _resetFileFormatsForTests,
  formatForFilename,
  listExportFormats,
  listFileFormats,
  listImportFormats,
  registerFileFormat,
  unregisterFileFormat,
} from '../../scripts/core/file_formats'
import {
  ANY_DATA_KIND,
  _resetPropsPanelsForTests,
  listPropsPanels,
  registerPropsPanel,
  unregisterPropsPanel,
} from '../../scripts/core/props_panels'
import {
  _resetUVSourcesForTests,
  listUVSources,
  registerUVSource,
  unregisterUVSource,
  uvSourceFor,
} from '../../scripts/core/uv_sources'

const ADDON_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/addon/addon_base.ts')

describe('file formats', () => {
  beforeEach(() => _resetFileFormatsForTests())

  test('a format round-trips through register / unregister', () => {
    registerFileFormat({id: 'stl', uiName: 'STL', extensions: ['.stl'], exportToBytes: () => new Uint8Array()})

    expect(listFileFormats().map((f) => f.id)).toEqual(['stl'])
    expect(listExportFormats().map((f) => f.id)).toEqual(['stl'])
    expect(listImportFormats()).toEqual([])

    unregisterFileFormat('stl')
    expect(listFileFormats()).toEqual([])
  })

  test('a duplicate id is an error, not a silent replacement', () => {
    const fmt = {id: 'obj', uiName: 'OBJ', extensions: ['.obj']}
    registerFileFormat(fmt)
    expect(() => registerFileFormat(fmt)).toThrow(/already registered/)
  })

  test('listing is sorted by id, not by registration order', () => {
    registerFileFormat({id: 'stl', uiName: 'STL', extensions: ['.stl']})
    registerFileFormat({id: 'obj', uiName: 'OBJ', extensions: ['.obj']})
    expect(listFileFormats().map((f) => f.id)).toEqual(['obj', 'stl'])
  })

  test('an extension resolves only to a format that can actually read it', () => {
    registerFileFormat({id: 'stl', uiName: 'STL', extensions: ['.stl'], exportToBytes: () => ''})
    expect(formatForFilename('bunny.STL')).toBeUndefined()

    registerFileFormat({id: 'obj', uiName: 'OBJ', extensions: ['.obj'], importFromBytes: () => {}})
    expect(formatForFilename('bunny.obj')?.id).toBe('obj')
    expect(formatForFilename('bunny')).toBeUndefined()
  })
})

describe('props panels', () => {
  beforeEach(() => _resetPropsPanelsForTests())

  const build = () => {}

  test('a panel is scoped to its kind, and a wildcard panel is not', () => {
    registerPropsPanel({id: 'litemesh.layers', kindId: 'litemesh', build})
    registerPropsPanel({id: 'any.custom', kindId: ANY_DATA_KIND, build})

    expect(listPropsPanels('litemesh').map((p) => p.id)).toEqual(['any.custom', 'litemesh.layers'])
    expect(listPropsPanels('curve').map((p) => p.id)).toEqual(['any.custom'])

    unregisterPropsPanel('any.custom')
    expect(listPropsPanels('curve')).toEqual([])
  })

  test('order wins over id, and id breaks ties', () => {
    registerPropsPanel({id: 'c', kindId: ANY_DATA_KIND, build})
    registerPropsPanel({id: 'a', kindId: ANY_DATA_KIND, build})
    registerPropsPanel({id: 'b', kindId: ANY_DATA_KIND, order: -1, build})

    expect(listPropsPanels().map((p) => p.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('UV sources', () => {
  beforeEach(() => _resetUVSourcesForTests())

  class Unwrappable {
    static dataDefine() {
      return {dataKind: 'litemesh'}
    }
  }

  test('a source is reached by kind, and disappears with its provider', () => {
    const source = {} as never
    registerUVSource({kindId: 'litemesh', resolve: () => source})

    expect(listUVSources().map((p) => p.kindId)).toEqual(['litemesh'])
    expect(uvSourceFor(new Unwrappable())).toBe(source)

    unregisterUVSource('litemesh')
    expect(uvSourceFor(new Unwrappable())).toBeUndefined()
  })

  test('an unregistered kind, and a provider with nothing to offer, both yield undefined', () => {
    registerUVSource({kindId: 'litemesh', resolve: () => undefined})

    expect(uvSourceFor(new Unwrappable())).toBeUndefined()
    expect(uvSourceFor({})).toBeUndefined()
    expect(uvSourceFor(undefined)).toBeUndefined()
  })
})

/**
 * §9's stated point is that module-scope registration works exactly once and
 * cannot be undone. A `register*` that forgets its undo thunk reintroduces
 * exactly that, and nothing else in the suite would notice.
 */
describe('AddonAPI registration is undoable', () => {
  const src = fs.readFileSync(ADDON_BASE, 'utf8')

  const CASES = [
    'registerDataKind',
    'registerTransType',
    'registerDefaultSceneBuilder',
    'registerFileMigrator',
    'registerFileFormat',
    'registerUVSource',
    'registerPropsPanel',
    // P8 (W1c) added these four so the mesh addon can hand back its keymap,
    // its ToolContext data-API subtree and its legacy struct names.
    'registerUIElement',
    'registerKeymapEntries',
    'registerContextStruct',
    'registerLegacyStructNames',
  ]

  test('every §9 case exists as a method', () => {
    for (const name of CASES) {
      expect(src).toMatch(new RegExp(`^  ${name}\\(`, 'm'))
    }
    expect(src).toMatch(/^  has\(id: string\): boolean \{/m)
  })

  test('every register* method body pushes exactly one undo thunk', () => {
    for (const name of CASES) {
      const start = src.search(new RegExp(`^  ${name}\\(`, 'm'))
      expect(start).toBeGreaterThan(-1)

      // Method bodies here are short and flat; the next `\n  }` closes this one.
      const end = src.indexOf('\n  }', start)
      const body = src.slice(start, end)

      expect([name, (body.match(/this\._undoRegistrations\.push\(/g) ?? []).length]).toEqual([name, 1])
    }
  })

  test('unregisterAll drains the undo list', () => {
    const body = src.slice(src.indexOf('  unregisterAll()'))
    expect(body).toMatch(/this\._undoRegistrations\.reverse\(\)/)
    expect(body).toMatch(/this\._undoRegistrations = \[\]/)
  })
})
