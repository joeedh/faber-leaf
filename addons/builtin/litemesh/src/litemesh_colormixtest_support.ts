/**
 * Integration-test support for the color paint brush's mix modes (color.sbrush
 * `mixMode` + SculptBrush.colorMixMode + ColorMixModes). Exposes
 * `globalThis.__colorMixTest()`; the NW.js headless harness drives it via
 * `--eval` and stores the result on `__evalTestResult`.
 *
 * Method: converge the vertex color layer to a uniform base (repeated MIX dabs
 * geometrically converge every painted vertex to the target regardless of
 * falloff), then apply each mode once and read the mean painted color. Because
 * every mode runs the same stroke over the same base, per-vertex falloff is
 * shared, so the *ordering* of channel means across modes matches the ordering
 * of the full-strength blend formulas — a falloff-robust check. With base 0.4
 * and brush color (0.5, 0.9, 0.3): MULTIPLY darkens, SCREEN lightens, DIFFERENCE
 * is lowest on R, DARKEN clamps G down, LIGHTEN raises B.
 */

import {Vector4} from '../../../../scripts/path.ux/scripts/pathux.js'
import {SculptTools, ColorMixModes} from '../../../../scripts/brush/brush_base'
import {DefaultBrushes, type SculptBrush} from '../../../../scripts/brush/index'
import {runSculptcoreStroke} from './sculptcore_ops'
import {AttrDomain, AttrUseFlags, LiteMesh} from './litemesh'
import {AttrType} from './litemesh_base'

interface BufWasm {
  HEAPU8?: {buffer: ArrayBufferLike}
  gpu: Record<string, unknown>
  getBoundVector(name: string, vec: unknown): ArrayLike<unknown>
  pointerBytes?(bound: unknown, member: string, byteLen: number): Uint8Array | undefined
}
interface BufDesc {
  size: number
  elemsize: number
  name?: string
  data?: number
}

/** Concatenate every GPU vertex buffer named `name` (mirrors the brush test). */
function readGpuBuffer(lm: LiteMesh, name: string): Float32Array | undefined {
  const wasm = lm.wasm as unknown as BufWasm
  const spatial = lm.spatial as unknown as {update?: (gpu: unknown) => void}
  spatial.update?.(wasm.gpu)
  const buffersVec = (wasm.gpu as {buffers?: unknown}).buffers
  const buffers =
    wasm.HEAPU8 !== undefined
      ? (buffersVec as ArrayLike<BufDesc>)
      : (wasm.getBoundVector('', buffersVec) as ArrayLike<BufDesc>)
  const parts: Float32Array[] = []
  let total = 0
  for (let i = 0; i < (buffers.length | 0); i++) {
    const buf = buffers[i]
    if (!buf || buf.name !== name || !(buf.size | 0) || !(buf.elemsize | 0)) {
      continue
    }
    const floatCount = (buf.size | 0) * (buf.elemsize | 0)
    const bytes = floatCount * 4
    let u8: Uint8Array | undefined
    if (wasm.HEAPU8 !== undefined) {
      u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data as number, bytes)
    } else {
      u8 = wasm.pointerBytes?.(buf, 'data', bytes)
    }
    if (!u8 || u8.length < bytes) {
      return undefined
    }
    parts.push(new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + bytes)))
    total += floatCount
  }
  if (!parts.length) {
    return undefined
  }
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

interface ModeMean {
  painted: number
  r: number
  g: number
  b: number
}

export interface ColorMixTestResult {
  ok: boolean
  error?: string
  base?: number
  brushColor?: number[]
  modes?: Record<string, ModeMean>
  checks?: Record<string, boolean>
}

/** Mean of the post-stroke color over verts whose color changed. */
function meanPainted(before: Float32Array, after: Float32Array): ModeMean {
  let painted = 0
  let sr = 0
  let sg = 0
  let sb = 0
  for (let i = 0; i + 3 < after.length; i += 4) {
    const d =
      Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) + Math.abs(after[i + 2] - before[i + 2])
    if (d > 0.02) {
      painted++
      sr += after[i]
      sg += after[i + 1]
      sb += after[i + 2]
    }
  }
  return {painted, r: painted ? sr / painted : 0, g: painted ? sg / painted : 0, b: painted ? sb / painted : 0}
}

async function colorMixTest(): Promise<ColorMixTestResult> {
  const r: ColorMixTestResult = {ok: false}
  try {
    const ctx = (globalThis as unknown as {_appstate: {ctx: {object?: {data?: unknown}}}})._appstate.ctx
    const mesh = ctx.object?.data
    if (!(mesh instanceof LiteMesh)) {
      throw new Error('active object is not a LiteMesh')
    }
    if (mesh.activeAttrLayerIndex(AttrUseFlags.COLOR) < 0) {
      mesh.addAttr(AttrDomain.VERTEX, AttrType.Float4, AttrUseFlags.COLOR)
    }

    const brush = DefaultBrushes.slotMap[SculptTools.COLOR] as SculptBrush
    const saved = {
      color   : new Vector4(brush.color),
      mode    : brush.colorMixMode,
      tool    : brush.tool,
      strength: brush.strength,
    }
    brush.tool = SculptTools.COLOR
    brush.strength = 1

    // Recover the pole distance from the position buffer, then use a radius that
    // comfortably covers a whole hemisphere so the painted set is large.
    const pos = readGpuBuffer(mesh, 'position')
    let R = 1
    if (pos) {
      let mx = 0
      for (let i = 0; i < pos.length; i++) {
        mx = Math.max(mx, Math.abs(pos[i]))
      }
      R = mx || 1
    }
    const radius = R * 4
    const dabs = [{p: [0, 0, R], normal: [0, 0, 1]}]
    const base = 0.4
    const c = [0.5, 0.9, 0.3]

    const setBase = () => {
      brush.colorMixMode = ColorMixModes.MIX
      brush.color.loadXYZW(base, base, base, 1)
      // Repeated MIX dabs converge each painted vertex to `base` regardless of
      // its per-vertex falloff strength.
      for (let i = 0; i < 12; i++) {
        runSculptcoreStroke({mesh, brush, dabs, radius})
      }
    }
    const runMode = (mode: number): ModeMean => {
      setBase()
      const before = readGpuBuffer(mesh, 'color')!
      brush.colorMixMode = mode
      brush.color.loadXYZW(c[0], c[1], c[2], 1)
      runSculptcoreStroke({mesh, brush, dabs, radius})
      const after = readGpuBuffer(mesh, 'color')!
      return meanPainted(before, after)
    }

    const modes: Record<string, ModeMean> = {
      MIX       : runMode(ColorMixModes.MIX),
      MULTIPLY  : runMode(ColorMixModes.MULTIPLY),
      SCREEN    : runMode(ColorMixModes.SCREEN),
      OVERLAY   : runMode(ColorMixModes.OVERLAY),
      DIFFERENCE: runMode(ColorMixModes.DIFFERENCE),
      DARKEN    : runMode(ColorMixModes.DARKEN),
      LIGHTEN   : runMode(ColorMixModes.LIGHTEN),
    }
    r.base = base
    r.brushColor = c
    r.modes = modes

    brush.color.load(saved.color)
    brush.colorMixMode = saved.mode
    brush.tool = saved.tool
    brush.strength = saved.strength

    // Falloff-robust relative checks (base 0.4, c=(0.5,0.9,0.3)):
    //   R full-strength: DIFFERENCE .1 < MULTIPLY .2 < OVERLAY .4 < MIX .5 < SCREEN .7
    //   G: DARKEN min(.4,.9)=.4 < MIX .9;  B: LIGHTEN max(.4,.3)=.4 > MIX .3
    const eps = 0.02
    const allPainted = Object.values(modes).every((m) => m.painted > 0)
    const checks: Record<string, boolean> = {
      allPainted,
      multiplyDarkensR : modes.MULTIPLY.r < modes.MIX.r - eps,
      screenLightensR  : modes.SCREEN.r > modes.MIX.r + eps,
      differenceLowestR: modes.DIFFERENCE.r < modes.MULTIPLY.r + eps,
      overlayBetweenR  : modes.OVERLAY.r > modes.MULTIPLY.r - eps && modes.OVERLAY.r < modes.MIX.r + eps,
      darkenClampsG    : modes.DARKEN.g < modes.MIX.g - eps,
      lightenRaisesB   : modes.LIGHTEN.b > modes.MIX.b + eps,
    }
    r.checks = checks
    r.ok = Object.values(checks).every(Boolean)
  } catch (e) {
    r.error = `${e}\n${e instanceof Error ? e.stack : ''}`
  }
  return r
}

declare global {
  interface Window {
    __colorMixTest: typeof colorMixTest
  }
}

window.__colorMixTest = colorMixTest
