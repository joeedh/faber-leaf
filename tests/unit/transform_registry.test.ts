/**
 * The transform-type registry half of §8: a transform op's default type set is
 * derived from what is registered, and a name whose type is gone is declined
 * rather than crashed on.
 *
 * Checked against the source rather than by importing it. `transform_ops.ts`
 * reaches the view3d editor and `_appstate` at module load, and even
 * `transform_base.ts` pulls `scripts/util/vectormath.js` — a `.js` file, which
 * this ESM-mode jest treats as CJS, so its `.ts` imports fail to load. Same
 * treatment `addon_registries.test.ts` gives `AddonAPI`.
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

const TRANSFORM_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/editors/view3d/transform'
)

const opsSrc = fs.readFileSync(path.join(TRANSFORM_DIR, 'transform_ops.ts'), 'utf8')
const baseSrc = fs.readFileSync(path.join(TRANSFORM_DIR, 'transform_base.ts'), 'utf8')

describe('the transform type set is derived, not written down', () => {
  test('the `types` input default comes from the registry', () => {
    expect(opsSrc).toMatch(/buildTypesProp\(TransDataType\.defaultTypeNames\(\)\)/)
    // The literal set the default used to be. A geometry type contributed by an
    // addon is invisible to a hardcoded list.
    expect(opsSrc).not.toMatch(/buildTypesProp\(\[/)
  })

  test('`defaultTypeNames` walks the registry and sorts it', () => {
    const body = baseSrc.slice(baseSrc.indexOf('  static defaultTypeNames('))
    const end = body.indexOf('\n  }')
    expect(body.slice(0, end)).toMatch(/TransDataTypes\.map\(.*transformDefine\(\)\.name\).*\.sort\(\)/s)
  })
})

describe('a name can outlive its type', () => {
  test('`getClass` admits it can miss', () => {
    expect(baseSrc).toMatch(/static getClass\(name: string\): ITransDataType \| undefined/)
  })

  test('`getTransTypes` skips a miss instead of dereferencing it', () => {
    const body = opsSrc.slice(opsSrc.indexOf('  getTransTypes('), opsSrc.indexOf('  genTransData('))
    expect(body).toMatch(/if \(!type \|\| !type\.isValid\(/)
  })

  test('unregister drops the type from both the list and the name map', () => {
    const body = baseSrc.slice(baseSrc.indexOf('  static unregister('))
    const end = body.indexOf('\n  }')
    const decl = body.slice(0, end)

    expect(decl).toMatch(/TransDataTypes\.splice\(/)
    expect(decl).toMatch(/delete TransDataMap\[/)
  })
})

describe('only an addon-owned type registers from an addon', () => {
  const REPO_ROOT = path.resolve(TRANSFORM_DIR, '../../../..')

  // Host code with no `register()` hook to move to. Each is allowed to stay at
  // module scope only while it says why, directly above the call.
  const HOST_REGISTRATIONS: [string, string][] = [
    ['scripts/editors/view3d/transform/transform_types.ts', 'ObjectTransType'],
    ['scripts/editors/view3d/widgets/widget_utils.ts', 'TransMovWidget'],
    ['scripts/lite-mesh/litemesh_transtype.ts', 'LiteMeshTransType'],
  ]

  test.each(HOST_REGISTRATIONS)('%s registers %s at module scope, with a reason', (rel, name) => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n')
    const at = lines.findIndex((l) => l.startsWith(`TransDataType.register(${name})`))

    expect(at).toBeGreaterThan(0)
    expect(lines[at - 1].trimStart()).toMatch(/^\/\//)
  })

  test('LeafMeshTransType is registered by its addon, not at module scope', () => {
    const typesSrc = fs.readFileSync(path.join(TRANSFORM_DIR, 'transform_types.ts'), 'utf8')
    expect(typesSrc).not.toMatch(/TransDataType\.register\(LeafMeshTransType\)/)
    // P13 erased the BREP type outright; the host file must not name it either.
    expect(typesSrc).not.toMatch(/MeshTransType/)

    const addon = path.join(REPO_ROOT, 'addons/builtin/leafmesh/src/main.ts')
    expect(fs.readFileSync(addon, 'utf8')).toMatch(/api\.registerTransType\(LeafMeshTransType\)/)
  })
})
