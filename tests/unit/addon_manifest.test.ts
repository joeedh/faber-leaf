/**
 * Tests the addon manifest validator + dependency-ordered sort. Step 5 of the
 * refactor (plan §2.2, §2.5, §6 step 5).
 */

import {
  ManifestValidationError,
  sortManifestsByDeps,
  validateManifest,
  type IAddonManifest,
} from '../../scripts/addon/manifest'

function manifest(over: Partial<IAddonManifest>): IAddonManifest {
  return {
    id          : 'mesh',
    name        : 'Mesh',
    version     : '1.0.0',
    entry       : 'src/main.ts',
    dependencies: [],
    buildMode   : 'prebuilt',
    ...over,
  }
}

describe('validateManifest', () => {
  test('accepts a minimal valid manifest', () => {
    const out = validateManifest({
      id     : 'mesh',
      name   : 'Mesh',
      version: '1.0.0',
      entry  : 'src/main.ts',
    })
    expect(out.id).toBe('mesh')
    expect(out.dependencies).toEqual([])
    expect(out.buildMode).toBe('prebuilt')
  })

  test('rejects bad id', () => {
    for (const bad of ['', 'Foo', '1demo', 'demo.edit', 'demo/edit']) {
      expect(() => validateManifest({id: bad, name: 'x', version: '1.0.0', entry: 'm.ts'})).toThrow(
        ManifestValidationError
      )
    }
  })

  test('rejects bad version', () => {
    for (const bad of ['1', '1.0', '1.0.0-rc1', 'v1.0.0']) {
      expect(() => validateManifest({id: 'a', name: 'A', version: bad, entry: 'm.ts'})).toThrow(/version/)
    }
  })

  test('rejects entry containing ..', () => {
    expect(() => validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: '../m.ts'})).toThrow(/\.\./)
  })

  test('rejects bad dependencies field', () => {
    expect(() => validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: 'm.ts', dependencies: 'mesh'})).toThrow(
      /dependencies/
    )
    expect(() =>
      validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: 'm.ts', dependencies: ['Foo']})
    ).toThrow(/Foo/)
  })

  test('rejects bad buildMode', () => {
    expect(() => validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: 'm.ts', buildMode: 'binary'})).toThrow(
      /buildMode/
    )
  })

  test('includes manifestPath in error message', () => {
    expect(() =>
      validateManifest({id: 'BAD', name: 'A', version: '1.0.0', entry: 'm.ts'}, 'addons/builtin/x/manifest.json')
    ).toThrow(/addons\/builtin\/x\/manifest\.json/)
  })
})

describe('sortManifestsByDeps', () => {
  test('returns deps before dependents', () => {
    const out = sortManifestsByDeps([
      manifest({id: 'sculpt', dependencies: ['mesh']}),
      manifest({id: 'mesh'}),
      manifest({id: 'curve', dependencies: ['mesh']}),
    ])
    const ids = out.map((m) => m.id)
    expect(ids.indexOf('mesh')).toBeLessThan(ids.indexOf('sculpt'))
    expect(ids.indexOf('mesh')).toBeLessThan(ids.indexOf('curve'))
  })

  test('handles transitive deps', () => {
    const out = sortManifestsByDeps([
      manifest({id: 'c', dependencies: ['b']}),
      manifest({id: 'a'}),
      manifest({id: 'b', dependencies: ['a']}),
    ])
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  test('rejects cycles', () => {
    expect(() =>
      sortManifestsByDeps([manifest({id: 'a', dependencies: ['b']}), manifest({id: 'b', dependencies: ['a']})])
    ).toThrow(/cycle/)
  })

  test('rejects self-cycle', () => {
    expect(() => sortManifestsByDeps([manifest({id: 'a', dependencies: ['a']})])).toThrow(/cycle/)
  })

  test('rejects unknown dependency', () => {
    expect(() => sortManifestsByDeps([manifest({id: 'a', dependencies: ['ghost']})])).toThrow(/ghost/)
  })

  test('rejects duplicate id', () => {
    expect(() => sortManifestsByDeps([manifest({id: 'a'}), manifest({id: 'a'})])).toThrow(/duplicate/)
  })
})
