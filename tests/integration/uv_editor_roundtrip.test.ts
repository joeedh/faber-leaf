/**
 * An unwrap-free UV edit survives a `.wproj` save and reload — P18 §6.
 *
 * The engine calls the flag sidecar persistent for exactly this reason ("a
 * .wproj must round-trip a UV selection", `sculptcore/source/mesh/mesh.h`), so
 * what is under test is the whole chain rather than that one decision:
 * `IUVSource.setUVFlags` / `setUVs` write through to the LiteMesh, the saved
 * blob carries both the UV column and the sidecar, and a reloaded file answers
 * the same through a *different* source instance over a *different* mesh.
 *
 * Headless because none of that exists outside the app — the serializer, the
 * addon that provides the source, and the `.wproj` writer are all app-side —
 * and because the editor's ops ship in an *external* addon, so only a real boot
 * that started its addons can invoke them.
 *
 * Elements are compared by *ring position* (face i, slot j), not by handle.
 * Handles are documented as opaque and valid only until `topoStamp` changes,
 * and a reload changes everything, so keying on them would assert an invariant
 * the contract never promised. Ring position is what the editor draws — and the
 * owner-vertex positions travel in the snapshot so that "the reload reordered
 * the rings" fails as itself instead of as a flag mismatch.
 *
 * Selection is written by the shipping op; the pin bits and the coordinate
 * nudge go through the source directly, which is what the remaining ops do
 * underneath (`uv_editor_ops.test.ts` covers them at the op level).
 */

import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {bootDump, REPO_ROOT, resolveNwjsExe} from './nwjs_boot'
import {isDefaultBackendPass} from './split'

const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const ADDON = Path.join(REPO_ROOT, 'build', 'addons', 'uv_editor', 'src', 'main.js')

/** One UV element, keyed by its position in the face rings. */
interface Elem {
  key: string
  flags: number
  u: number
  v: number
  /** Owner-vertex position, object-local, or null if the source omits them. */
  co: [number, number, number] | null
}

interface RoundTripResult {
  ok: boolean
  error?: string
  stack?: string

  /** As generated, before anything was edited. */
  original?: Elem[]

  /** After the edit, before the save. */
  before?: Elem[]

  /** After the save and reload — same layer, different mesh. */
  after?: Elem[]

  layerNames?: string[]
  afterLayerNames?: string[]
  savedBytes?: number
  obName?: string
  afterObName?: string
  /** Whether the reload handed back the same adapter object. It must not. */
  sameSource?: boolean
}

/**
 * `--eval` is passed as two argv tokens, so this may be a normal multi-line
 * expression (`file_compat.test.ts` boots the same way). `SAVE_PATH` is
 * substituted as a JSON string literal.
 */
function roundTripEval(savePath: string): string {
  return `globalThis.__evalTestResult = (() => {
  try {
    const nodefs = require('fs')
    const UV_SELECT = 1
    const UV_PIN = 2

    // The active object first, then the rest of the scene: which object a
    // reload leaves active is not what this suite is about.
    const findSource = () => {
      const ctx = _appstate.ctx
      const cands = ctx.object ? [ctx.object] : []
      for (const ob of ctx.scene.objects) {
        if (cands.indexOf(ob) < 0) cands.push(ob)
      }
      for (const ob of cands) {
        const src = _framework.api.uvSourceFor(ob.data)
        if (src && src.activeUVLayer >= 0) return {ob, src, layer: src.activeUVLayer}
      }
      return undefined
    }

    const elements = (src, layer) => {
      const faces = src.listUVFaces(layer, false)
      const rings = src.getUVFaceRings(layer, faces)
      const handles = []
      const keys = []
      for (let i = 0; i < faces.length; i++) {
        for (let j = rings.offsets[i]; j < rings.offsets[i + 1]; j++) {
          handles.push(rings.values[j])
          keys.push(i + ':' + (j - rings.offsets[i]))
        }
      }
      return {handles: Int32Array.from(handles), keys}
    }

    const snapshot = (src, layer) => {
      const got = elements(src, layer)
      const flags = src.getUVFlags(layer, got.handles)
      const uvs = src.getUVs(layer, got.handles)
      const pos = src.getUVElementPositions ? src.getUVElementPositions(layer, got.handles) : undefined
      const out = []
      for (let i = 0; i < got.keys.length; i++) {
        out.push({
          key  : got.keys[i],
          flags: flags[i],
          u    : uvs[i * 2],
          v    : uvs[i * 2 + 1],
          co   : pos ? [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] : null,
        })
      }
      return out
    }

    const found = findSource()
    if (!found) return {ok: false, error: 'no object in the generated scene has a UV layer'}

    const src = found.src
    const layer = found.layer
    const layerNames = Array.from(src.listUVLayers())
    const original = snapshot(src, layer)

    const ctx = _appstate.ctx
    ctx.api.execTool(ctx, 'uveditor.toggle_select_all', {mode: 0, selectedFacesOnly: false})

    // A mixed column: an all-ones one would match whatever came back. Every
    // third element keeps SELECT, every fourth gains PIN, and the offsets are
    // chosen so some elements carry both and some carry neither.
    const handles = elements(src, layer).handles
    const flags = src.getUVFlags(layer, handles)
    const uvs = src.getUVs(layer, handles)
    for (let i = 0; i < handles.length; i++) {
      if (i % 3 !== 0) flags[i] &= ~UV_SELECT
      if (i % 4 === 1) flags[i] |= UV_PIN
      // Binary fractions, so the nudge is exact in float32 and a mismatch after
      // the reload is a real one rather than rounding.
      uvs[i * 2] += (i % 5) * 0.03125
      uvs[i * 2 + 1] += (i % 3) * 0.015625
    }
    src.setUVFlags(layer, handles, flags)
    src.setUVs(layer, handles, uvs)

    const before = snapshot(src, layer)
    const obName = found.ob.name

    const savePath = ${JSON.stringify(savePath)}
    const buf = _appstate.createFile({save_screen: true, save_library: true, compress: false})
    nodefs.writeFileSync(savePath, Buffer.from(new Uint8Array(buf)))

    const raw = nodefs.readFileSync(savePath)
    _appstate.loadFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))

    const back = findSource()
    if (!back) return {ok: false, error: 'the reloaded file has no object with a UV layer', before}

    return {
      ok             : true,
      original       : original,
      before         : before,
      after          : snapshot(back.src, back.layer),
      layerNames     : layerNames,
      afterLayerNames: Array.from(back.src.listUVLayers()),
      savedBytes     : buf.byteLength,
      obName         : obName,
      afterObName    : back.ob.name,
      sameSource     : back.src === src,
    }
  } catch (e) {
    return {ok: false, error: String(e), stack: String(e && e.stack)}
  }
})()`
}

function probe(nwExe: string): RoundTripResult {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'uvroundtrip-'))
  const save = Path.join(dir, 'uv-edit.wproj')

  const dump = bootDump(
    nwExe,
    [
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      'wasm',
      '--gen-scene',
      'litemesh-attrtest',
      '--scene-arg',
      'subdiv=2',
      '--eval',
      roundTripEval(save),
    ],
    {tmpPrefix: 'uvroundtrip-', timeout: 240000}
  ) as {evalResult?: RoundTripResult}

  if (!dump.evalResult) {
    throw new Error('eval did not report back (see harness stderr for the throw)')
  }
  return dump.evalResult
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveAddon = fs.existsSync(ADDON)
// Nothing here is backend-specific -- the serializer and the sidecar are the
// same code either way -- so it runs once, in the wasm pass.
const canRun = !!nwExe && haveBundle && haveAddon && isDefaultBackendPass()

if (!canRun && isDefaultBackendPass()) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
    !haveAddon && `uv_editor addon not built (${Path.relative(REPO_ROOT, ADDON)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[uv-editor-roundtrip] skipped: ${why}`)
}

const maybe = canRun ? describe : describe.skip

maybe('a UV edit survives a .wproj round trip (headless)', () => {
  let result: RoundTripResult

  beforeAll(() => {
    result = probe(nwExe!)
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`[uv-editor-roundtrip] eval failed: ${result.error}\n${result.stack ?? ''}`)
    }
  }, 300000)

  test('the scene had a UV layer to edit, and a file was written', () => {
    expect(result.ok).toBe(true)
    expect(result.layerNames!.length).toBeGreaterThan(0)
    expect(result.savedBytes!).toBeGreaterThan(0)
    expect(result.before!.length).toBeGreaterThan(0)
  })

  test('the edit was a real one: a mixed flag column and moved UVs', () => {
    const before = result.before!
    const selected = before.filter((e) => e.flags & 1)
    const pinned = before.filter((e) => e.flags & 2)

    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThan(before.length)
    expect(pinned.length).toBeGreaterThan(0)
    // At least one element carries neither bit, so a saved column of ones
    // cannot pass the comparison below by accident.
    expect(before.some((e) => e.flags === 0)).toBe(true)

    const was = new Map(result.original!.map((e) => [e.key, e]))
    expect(before.some((e) => Math.abs(e.u - was.get(e.key)!.u) > 1e-6)).toBe(true)
  })

  test('the reload really is a second mesh, under the same object and layer', () => {
    expect(result.sameSource).toBe(false)
    expect(result.afterObName).toBe(result.obName)
    expect(result.afterLayerNames).toEqual(result.layerNames)
    expect(result.after!.length).toBe(result.before!.length)
  })

  test('the rings came back in the same order, so the keys mean the same thing', () => {
    const after = new Map(result.after!.map((e) => [e.key, e]))

    for (const e of result.before!) {
      const got = after.get(e.key)
      expect(got).toBeDefined()
      if (!e.co || !got!.co) {
        continue
      }
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(got!.co[i] - e.co[i])).toBeLessThan(1e-5)
      }
    }
  })

  test('selection and pin state survive the round trip', () => {
    const after = new Map(result.after!.map((e) => [e.key, e]))

    for (const e of result.before!) {
      // Keyed so a failure names the element rather than reporting 1 !== 3.
      expect(`${e.key}=${after.get(e.key)!.flags}`).toBe(`${e.key}=${e.flags}`)
    }
  })

  test('the edited coordinates survive the round trip', () => {
    const after = new Map(result.after!.map((e) => [e.key, e]))

    for (const e of result.before!) {
      const got = after.get(e.key)!
      expect(Math.abs(got.u - e.u)).toBeLessThan(1e-6)
      expect(Math.abs(got.v - e.v)).toBeLessThan(1e-6)
    }
  })
})
