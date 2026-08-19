/**
 * @jest-environment node
 *
 * End-to-end test for the `@addon/<id>/api` runtime resolver (deferred
 * follow-up #2). The api_consumer fixture imports symbols from
 * `@addon/leafmesh/api`; the build pipeline replaces those imports with a tiny
 * lookup stub that reads from `globalThis._addons.getAddonAPI('leafmesh').
 * exports.leafmesh.*` at module-load time.
 *
 * This test:
 *   1. Runs `node tools/build-addons.js --include-fixtures` to produce
 *      `build/addons/api_consumer/src/main.js`.
 *   2. Asserts that the built bundle contains the lookup stub and does NOT
 *      contain the leafmesh source code (so we know the resolver did its job).
 *   3. Sets up a mock `_addons` global with stand-in leafmesh exports, then
 *      dynamic-imports the built bundle and confirms the resolved symbols
 *      match the mocks. Demonstrates that consumer addons get late-bound
 *      values from the host.
 *
 * Node test environment so we can use `fs` + `execSync` and so esbuild-wasm
 * (loaded transitively by the source-mode install path elsewhere) isn't
 * tripped up by jsdom's realm split.
 */

import {execSync} from 'node:child_process'
import fs from 'node:fs'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isDefaultBackendPass} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '..', '..')
const BUILT_ENTRY = Path.join(REPO_ROOT, 'build/addons/api_consumer/src/main.js')
const INDEX_PATH = Path.join(REPO_ROOT, 'build/addons/index.json')

/**
 * Reads the built entry plus any sibling chunk(s) it statically imports, joined.
 * esbuild's code-splitting hoists the `@addon/leafmesh/api` stub into a shared
 * `_chunks/` module when more than one addon imports it, so the stub may live
 * in a chunk rather than inline in main.js.
 */
function readBuiltWithChunks(entry: string): string {
  const seen = new Set<string>()
  const parts: string[] = []
  const visit = (file: string) => {
    if (seen.has(file) || !fs.existsSync(file)) return
    seen.add(file)
    const src = fs.readFileSync(file, 'utf-8')
    parts.push(src)
    for (const m of src.matchAll(/from\s*["']([^"']+\.js)["']/g)) {
      visit(Path.resolve(Path.dirname(file), m[1]))
    }
  }
  visit(entry)
  return parts.join('\n')
}

/** Whether `build/addons/index.json` currently lists an addon by id. */
function indexNames(id: string): boolean {
  try {
    const json = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'))
    return json.some((e: {manifest: {id: string}}) => e.manifest.id === id)
  } catch {
    return false
  }
}

interface MockAddonAPI {
  exports: {[name: string]: Record<string, unknown>}
}

// No NW.js boot, so no backend: runs once, in the wasm pass (see ./split).
const describeOnce = isDefaultBackendPass() ? describe : describe.skip

describeOnce('addon_api_plugin (runtime resolver)', () => {
  beforeAll(() => {
    // Both artifacts, not just the entry: a plain `pnpm build` rewrites
    // index.json without the fixtures while leaving their bundles on disk, so
    // an entry-only guard skips the rebuild the index test needs.
    if (!fs.existsSync(BUILT_ENTRY) || !indexNames('api_consumer')) {
      execSync('node tools/build-addons.js --include-fixtures', {
        cwd  : REPO_ROOT,
        stdio: 'pipe',
      })
    }
  }, 30000)

  test('emits a stub bundle, not inlined mesh source', () => {
    // Read main.js + any chunk it imports — esbuild may hoist the shared
    // @addon/leafmesh/api stub into a _chunks/ module.
    const built = readBuiltWithChunks(BUILT_ENTRY)

    // The stub reaches into globalThis._addons.getAddonAPI("leafmesh") and
    // pulls each requested symbol from the exports.leafmesh namespace.
    expect(built).toMatch(/globalThis\._addons.*getAddonAPI/s)
    expect(built).toMatch(/__ns\["LeafMesh"\]/)
    expect(built).toMatch(/__ns\["LeafMeshData"\]/)
    expect(built).toMatch(/__ns\["AttrType"\]/)
    expect(built).toMatch(/__ns\["makeCube"\]/)

    // The actual leafmesh implementation must NOT appear here. The stub *names*
    // every symbol api.ts re-exports, so a bare name proves nothing — spot-check
    // definitions, plus a name api.ts does not re-export at all.
    expect(built).not.toMatch(/class LeafMeshData extends SceneObjectData/)
    expect(built).not.toMatch(/splitEdge/) // a topo.ts method, not an api.ts export
    expect(built).not.toMatch(/function triangulateMesh/) // a triangulate.ts definition
    // And the bundle should be small — much smaller than even one leafmesh file.
    expect(built.length).toBeLessThan(20 * 1024) // 20kb cap
  })

  test('runtime lookup yields the host-registered symbols', async () => {
    // Mock the host AddonManager surface that the stub reads from.
    const mockLeafSymbols = {
      LeafMesh    : class MockLeafMesh {},
      LeafMeshData: class MockLeafMeshData {},
      AttrType    : {F32: 1, I32: 2},
      makeCube    : () => 42,
    }
    ;(globalThis as unknown as {_addons: {getAddonAPI: (id: string) => MockAddonAPI | undefined}})._addons = {
      getAddonAPI(id: string): MockAddonAPI | undefined {
        if (id === 'leafmesh') return {exports: {leafmesh: mockLeafSymbols}}
        return undefined
      },
    }

    // Dynamic-import the built bundle. file:// URLs are required because
    // we're outside the workspace's module resolver.
    const mod = (await import('file://' + BUILT_ENTRY)) as {
      getResolvedSymbols: () => {
        LeafMesh: unknown
        LeafMeshData: unknown
        AttrType: unknown
        makeCube: unknown
      }
      addonDefine: {name: string}
      register: () => void
      unregister: () => void
      seen: string[]
    }

    expect(mod.addonDefine.name).toBe('API Consumer')

    const resolved = mod.getResolvedSymbols()
    expect(resolved.LeafMesh).toBe(mockLeafSymbols.LeafMesh)
    expect(resolved.LeafMeshData).toBe(mockLeafSymbols.LeafMeshData)
    expect(resolved.AttrType).toBe(mockLeafSymbols.AttrType)
    expect(resolved.makeCube).toBe(mockLeafSymbols.makeCube)

    mod.register()
    mod.unregister()
    expect(mod.seen).toEqual(['register', 'unregister'])
  })

  test('build emits the consumer manifest into the index', () => {
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'))
    const consumer = index.find((e: {manifest: {id: string}}) => e.manifest.id === 'api_consumer')
    expect(consumer).toBeDefined()
    expect(consumer.manifest.dependencies).toEqual(['leafmesh'])
  })
})
