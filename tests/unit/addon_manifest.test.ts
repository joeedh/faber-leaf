/**
 * Tests the addon manifest validator + the dependency resolver. Step 5 of the
 * refactor (plan §2.2, §2.5, §6 step 5); the optional-dependency semantics are
 * P14 §10.2 D2-D5.
 */

import {
  ManifestValidationError,
  resolveManifests,
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

  test('carries optional + optionalDependencies through, defaulted', () => {
    const bare = validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: 'm.ts'})
    expect(bare.optional).toBe(false)
    expect(bare.optionalDependencies).toEqual([])

    const out = validateManifest({
      id                  : 'a',
      name                : 'A',
      version             : '1.0.0',
      entry               : 'm.ts',
      optional            : true,
      optionalDependencies: ['mesh'],
    })
    expect(out.optional).toBe(true)
    expect(out.optionalDependencies).toEqual(['mesh'])
  })

  test('rejects an unknown field by name', () => {
    expect(() =>
      validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: 'm.ts', optionalDeps: ['mesh']})
    ).toThrow(/optionalDeps/)
  })

  test('rejects bad optionalDependencies', () => {
    expect(() =>
      validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: 'm.ts', optionalDependencies: 'mesh'})
    ).toThrow(/optionalDependencies/)
    expect(() =>
      validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: 'm.ts', optionalDependencies: ['Foo']})
    ).toThrow(/Foo/)
  })

  test('rejects a non-boolean optional', () => {
    expect(() => validateManifest({id: 'a', name: 'A', version: '1.0.0', entry: 'm.ts', optional: 'yes'})).toThrow(
      /optional/
    )
  })

  test('rejects an id listed as both required and optional', () => {
    expect(() =>
      validateManifest({
        id                  : 'a',
        name                : 'A',
        version             : '1.0.0',
        entry               : 'm.ts',
        dependencies        : ['mesh'],
        optionalDependencies: ['mesh'],
      })
    ).toThrow(/both a required and an optional/)
  })

  test('includes manifestPath in error message', () => {
    expect(() =>
      validateManifest({id: 'BAD', name: 'A', version: '1.0.0', entry: 'm.ts'}, 'addons/builtin/x/manifest.json')
    ).toThrow(/addons\/builtin\/x\/manifest\.json/)
  })
})

describe('resolveManifests', () => {
  const ids = (ms: IAddonManifest[]) => ms.map((m) => m.id)

  test('returns deps before dependents', () => {
    const {loaded, disabled} = resolveManifests([
      manifest({id: 'sculpt', dependencies: ['mesh']}),
      manifest({id: 'mesh'}),
      manifest({id: 'curve', dependencies: ['mesh']}),
    ])
    expect(disabled).toEqual([])
    const out = ids(loaded)
    expect(out.indexOf('mesh')).toBeLessThan(out.indexOf('sculpt'))
    expect(out.indexOf('mesh')).toBeLessThan(out.indexOf('curve'))
  })

  test('handles transitive deps', () => {
    const {loaded} = resolveManifests([
      manifest({id: 'c', dependencies: ['b']}),
      manifest({id: 'a'}),
      manifest({id: 'b', dependencies: ['a']}),
    ])
    expect(ids(loaded)).toEqual(['a', 'b', 'c'])
  })

  test('orders by id, not by input order', () => {
    const forwards = resolveManifests([manifest({id: 'a'}), manifest({id: 'b'}), manifest({id: 'c'})])
    const backwards = resolveManifests([manifest({id: 'c'}), manifest({id: 'b'}), manifest({id: 'a'})])
    expect(ids(forwards.loaded)).toEqual(['a', 'b', 'c'])
    expect(ids(backwards.loaded)).toEqual(['a', 'b', 'c'])
  })

  test('rejects cycles', () => {
    expect(() =>
      resolveManifests([manifest({id: 'a', dependencies: ['b']}), manifest({id: 'b', dependencies: ['a']})])
    ).toThrow(/cycle/)
  })

  test('rejects self-cycle', () => {
    expect(() => resolveManifests([manifest({id: 'a', dependencies: ['a']})])).toThrow(/cycle/)
  })

  test('rejects duplicate id', () => {
    expect(() => resolveManifests([manifest({id: 'a'}), manifest({id: 'a'})])).toThrow(/duplicate/)
  })

  test('disables — rather than throws on — a missing required dependency', () => {
    const {loaded, disabled} = resolveManifests([manifest({id: 'a', dependencies: ['ghost']}), manifest({id: 'b'})])
    expect(ids(loaded)).toEqual(['b'])
    expect(disabled).toEqual([
      {
        id        : 'a',
        reason    : 'missing-dep',
        dependency: 'ghost',
        message   : expect.stringContaining('ghost'),
      },
    ])
  })

  test('disables a dependent of a disabled addon, transitively', () => {
    const {loaded, disabled} = resolveManifests([
      manifest({id: 'a', dependencies: ['ghost']}),
      manifest({id: 'b', dependencies: ['a']}),
      manifest({id: 'c', dependencies: ['b']}),
    ])
    expect(loaded).toEqual([])
    expect(disabled.map((d) => [d.id, d.reason])).toEqual([
      ['a', 'missing-dep'],
      ['b', 'dep-disabled'],
      ['c', 'dep-disabled'],
    ])
  })

  test('an absent optional dependency does not disable anything', () => {
    const {loaded, disabled} = resolveManifests([manifest({id: 'a', optionalDependencies: ['ghost']})])
    expect(ids(loaded)).toEqual(['a'])
    expect(disabled).toEqual([])
  })

  test('a present optional dependency still orders first', () => {
    const {loaded} = resolveManifests([manifest({id: 'a', optionalDependencies: ['mesh']}), manifest({id: 'mesh'})])
    expect(ids(loaded)).toEqual(['mesh', 'a'])
  })

  test('a disabled optional dependency does not disable its dependent', () => {
    const {loaded, disabled} = resolveManifests([
      manifest({id: 'a', optionalDependencies: ['mesh']}),
      manifest({id: 'mesh', dependencies: ['ghost']}),
    ])
    expect(ids(loaded)).toEqual(['a'])
    expect(disabled.map((d) => d.id)).toEqual(['mesh'])
  })
})
