/**
 * WGSL emitter for the shader-node graph. Walks the graph in sorted order
 * and asks each node to emit its own WGSL via `node.genWgsl(this)` (the
 * per-node codegen lives on the `ShaderNode` subclasses themselves, in
 * `shader_nodes.ts` / `math_node.ts`). This generator owns the shared
 * machinery: socket naming, type coercion, uniform/texture collection, and
 * assembly of the final WGSL module.
 *
 * Conventions (see `shader_lib_wgsl.ts`):
 *   `@group(0)` — per-frame uniforms + AO texture
 *   `@group(1)` — material: POINTLIGHTS @binding(0), SUNLIGHTS @binding(1),
 *                 material struct @binding(2), images @binding(3+)
 *   `@group(2)` — per-object (objectMatrix, normalMatrix, object_id, alpha)
 */

import type {Graph, GenericNode, NodeSocketType} from '../core/graph.js'
import {SocketTypes} from '../core/graph.js'
import {FloatSocket, Vec2Socket, Vec3Socket, Vec4Socket, Matrix4Socket} from '../core/graphsockets.js'
import type {ImageBlock} from '../image/image.js'
import {ShaderNode, OutputNode, ShaderContext, ClosureSocket} from './shader_nodes.js'
import {
  CLOSURE_WGSL,
  OBJECT_UNIFORMS_WGSL,
  FRAME_UNIFORMS_WGSL,
  SHADER_LIB_WGSL,
  ALPHA_HASH_WGSL,
  LightGenWgsl,
  type IRenderLights,
} from './shader_lib_wgsl.js'
import type {MaterialAttrRequest} from '../core/vertex_layout.js'
import {preprocess} from '../shaders/preprocess.js'

/**
 * One geometry attribute a material reads (via an `AttributeNode`). Collected
 * while walking the graph, deduped by `name`, slot-assigned after the walk.
 * This array is the contract the renderengine hands to sculptcore: build one
 * vertex buffer per entry (by name), at the given `slot`, of `elemSize`
 * components — default-filled when the source layer is absent.
 *
 * `name` / `slot` / `elemSize` come from {@link MaterialAttrRequest} — the part
 * a provider needs. `slot` is left at -1 until the graph walk finishes and
 * `_assignAttrSlots` numbers them 2 upward; the fields below are the
 * generator's own.
 */
export interface RequestedAttrDesc extends MaterialAttrRequest {
  /** `AttributeCategory` (matches sculptcore AttrUse: COLOR=2, UV=4, GENERIC=0). */
  category: number
  /** Sanitized WGSL field name in VsIn/VsOut (e.g. `attr_uv`). */
  field: string
  /** WGSL element type (`vec2f` / `vec3f` / `vec4f`). */
  wgslType: string
  /** sculptcore `AttrType` bitflag (FLOAT2=2, FLOAT3=4, FLOAT4=8). */
  gpuType: number
}

/** Map an `AttributeCategory` to its WGSL/GPU element type. */
function attrCategoryType(category: number): {wgslType: string; gpuType: number; elemSize: number} {
  // AttributeCategory.COLOR === 2, UV === 4 (AttrUse bitflags); GENERIC === 0.
  if (category === 4) return {wgslType: 'vec2f', gpuType: 2, elemSize: 2} // UV → FLOAT2
  if (category === 2) return {wgslType: 'vec4f', gpuType: 8, elemSize: 4} // COLOR → FLOAT4
  return {wgslType: 'vec3f', gpuType: 4, elemSize: 3} // GENERIC → FLOAT3
}

function sanitizeAttrField(name: string): string {
  return 'attr_' + name.trim().replace(/[^A-Za-z0-9_]/g, '_')
}

/**
 * VDM fragment-sampling library (displacementAndSubSurf plan, V3), emitted only
 * when `generateWgsl` runs with `VDM_MODE` set. `@group(3)` holds the tile
 * atlas (rgba32float — non-filterable, hence the manual bilinear over
 * `textureLoad`s), the page table (`grid × grid` r32sint; -1 = unallocated →
 * sample zero), and the layout uniforms; the LiteMesh draw path seeds them
 * (see `litemesh.ts` `_syncVdmGpu`). The 4 bilinear taps are clamped to the
 * sample's own tile — the store's one-texel dilation skirts carry chart-edge
 * values, so clamping never blends toward a neighbouring chart or zero.
 */
const VDM_SAMPLE_WGSL = `
struct VdmParams {
  vdmTileSize : i32,
  vdmGridSize : i32,
  vdmAtlasTilesX : i32,
  vdmResolution : f32,
};
@group(3) @binding(0) var vdm_atlas : texture_2d<f32>;
@group(3) @binding(1) var vdm_page : texture_2d<i32>;
@group(3) @binding(2) var<uniform> vdmParams : VdmParams;

fn vdmSample(uv : vec2f) -> vec3f {
  let res = vdmParams.vdmResolution;
  let ts = vdmParams.vdmTileSize;
  let uvc = clamp(uv, vec2f(0.0), vec2f(1.0));
  let p = uvc * res - vec2f(0.5);
  let p0 = vec2i(floor(p));
  let f = p - floor(p);
  let tc = clamp(vec2i(uvc * res), vec2i(0), vec2i(i32(res) - 1));
  let tile = clamp(tc / ts, vec2i(0), vec2i(vdmParams.vdmGridSize - 1));
  let slot = textureLoad(vdm_page, tile, 0).x;
  if (slot < 0) {
    return vec3f(0.0);
  }
  let cell = vec2i(slot % vdmParams.vdmAtlasTilesX, slot / vdmParams.vdmAtlasTilesX) * ts;
  let lo = tile * ts;
  let hi = vec2i(ts - 1);
  let d00 = textureLoad(vdm_atlas, cell + clamp(p0 - lo, vec2i(0), hi), 0).xyz;
  let d10 = textureLoad(vdm_atlas, cell + clamp(p0 + vec2i(1, 0) - lo, vec2i(0), hi), 0).xyz;
  let d01 = textureLoad(vdm_atlas, cell + clamp(p0 + vec2i(0, 1) - lo, vec2i(0), hi), 0).xyz;
  let d11 = textureLoad(vdm_atlas, cell + clamp(p0 + vec2i(1, 1) - lo, vec2i(0), hi), 0).xyz;
  return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
}
`

/**
 * PTEX variant of the sampling library (X2 stage 3): `vdm_page` holds the flat
 * per-grid offset table (`gpuPtexTable` layout) instead of the [0,1]² page
 * table, linearly indexed by texel fetches. The grid id is recovered from the
 * X1 grid-chart uv (`floor(uv·cpr)` — the inset gutter keeps interior
 * fragments in-cell; `vdmGridSize` carries cpr in this mode), the local param
 * is un-inset, and taps address the (R+2)² storage lattice (+1 guard-ring
 * offset) with a PER-TAP slot lookup, so taps may straddle tiles and land on
 * the copied border skirts — bilinear is seamless across grids.
 */
const VDM_SAMPLE_PTEX_WGSL = `
struct VdmParams {
  vdmTileSize : i32,
  vdmGridSize : i32,
  vdmAtlasTilesX : i32,
  vdmResolution : f32,
};
@group(3) @binding(0) var vdm_atlas : texture_2d<f32>;
@group(3) @binding(1) var vdm_page : texture_2d<i32>;
@group(3) @binding(2) var<uniform> vdmParams : VdmParams;

fn vdmPtexFetch(idx : i32) -> i32 {
  let w = i32(textureDimensions(vdm_page, 0).x);
  return textureLoad(vdm_page, vec2i(idx % w, idx / w), 0).x;
}

fn vdmLoadP(off : i32, tps : i32, ext : i32, x : i32, y : i32) -> vec3f {
  let ts = vdmParams.vdmTileSize;
  let sx = clamp(x, 0, ext - 1);
  let sy = clamp(y, 0, ext - 1);
  let slot = vdmPtexFetch(off + (sy / ts) * tps + sx / ts);
  if (slot < 0) {
    return vec3f(0.0);
  }
  let cell = vec2i(slot % vdmParams.vdmAtlasTilesX, slot / vdmParams.vdmAtlasTilesX) * ts;
  return textureLoad(vdm_atlas, cell + vec2i(sx % ts, sy % ts), 0).xyz;
}

fn vdmSample(uv : vec2f) -> vec3f {
  let cpr = vdmParams.vdmGridSize;
  let uvc = clamp(uv, vec2f(0.0), vec2f(1.0));
  let cellX = clamp(i32(floor(uvc.x * f32(cpr))), 0, cpr - 1);
  let cellY = clamp(i32(floor(uvc.y * f32(cpr))), 0, cpr - 1);
  let grid = cellY * cpr + cellX;
  if (grid >= vdmPtexFetch(0)) {
    return vec3f(0.0);
  }
  let hdr = 1 + grid * 3;
  let off = vdmPtexFetch(hdr);
  let r = vdmPtexFetch(hdr + 1);
  let tps = vdmPtexFetch(hdr + 2);
  if (r <= 0) {
    return vec3f(0.0);
  }
  // Un-inset the packed chart uv into the grid-local param (assignGridUVs:
  // cell = 1/cpr, inset = cell/32, span = cell - 2*inset).
  let cell = 1.0 / f32(cpr);
  let inset = cell / 32.0;
  let span = cell - 2.0 * inset;
  let lu = clamp((uvc.x - f32(cellX) * cell - inset) / span, 0.0, 1.0);
  let lv = clamp((uvc.y - f32(cellY) * cell - inset) / span, 0.0, 1.0);
  // Payload -> storage coords (+1 for the guard ring); centers at +0.5.
  let px = lu * f32(r) - 0.5 + 1.0;
  let py = lv * f32(r) - 0.5 + 1.0;
  let fx = floor(px);
  let fy = floor(py);
  let ax = px - fx;
  let ay = py - fy;
  let x0 = i32(fx);
  let y0 = i32(fy);
  let ext = r + 2;
  let d00 = vdmLoadP(off, tps, ext, x0, y0);
  let d10 = vdmLoadP(off, tps, ext, x0 + 1, y0);
  let d01 = vdmLoadP(off, tps, ext, x0, y0 + 1);
  let d11 = vdmLoadP(off, tps, ext, x0 + 1, y0 + 1);
  return mix(mix(d00, d10, ax), mix(d01, d11, ax), ay);
}
`

/**
 * The fs_main preamble for VDM mode: reconstruct the displaced surface point
 * in object space through the F3 frame (`base + t·D.x + b·D.y + n·D.z`, the
 * exact inverse of the splat's tangent projection), then derive the shading
 * normal analytically as `cross(∂S/∂x, ∂S/∂y)` with the displacement gradient
 * taken in *texel* space (±half-texel central differences, so the bilinear
 * taps stay inside the store's 1.5-texel dilation skirts) and chained through
 * `dpdx/dpdy(uv)`. Interpolated varyings
 * are affine per triangle, so their screen derivatives are exact even in
 * helper invocations at chart edges — unlike naive `dpdx(displacedPos)`,
 * which embeds texture lookups at extrapolated UVs and turns every per-face
 * chart boundary into derivative noise. The rewrites land on a local
 * `var input` copy so every downstream `input.*` read (node codegen,
 * lighting) picks them up; texels of exactly zero leave the fragment
 * untouched, so flat regions shade identically to the non-VDM material.
 */
function buildVdmPreamble(uvField: string, normalField: string, tangentField: string): string {
  return `  var input = inputRaw;
  {
    let vdm_uv = inputRaw.${uvField};
    let vdm_d = vdmSample(vdm_uv);
    var vdm_n = inputRaw.${normalField};
    vdm_n = vdm_n / max(length(vdm_n), 1e-9);
    var vdm_t = inputRaw.${tangentField} - vdm_n * dot(vdm_n, inputRaw.${tangentField});
    vdm_t = vdm_t / max(length(vdm_t), 1e-9);
    let vdm_b = cross(vdm_n, vdm_t);
    let vdm_pO = inputRaw.vLocalCo + vdm_t * vdm_d.x + vdm_b * vdm_d.y + vdm_n * vdm_d.z;
    let vdm_pW = (object.objectMatrix * vec4f(vdm_pO, 1.0)).xyz;
    let vdm_e = 0.5 / vdmParams.vdmResolution;
    let vdm_ddu = (vdmSample(vdm_uv + vec2f(vdm_e, 0.0)) - vdmSample(vdm_uv - vec2f(vdm_e, 0.0))) * (0.5 / vdm_e);
    let vdm_ddv = (vdmSample(vdm_uv + vec2f(0.0, vdm_e)) - vdmSample(vdm_uv - vec2f(0.0, vdm_e))) * (0.5 / vdm_e);
    let vdm_duvx = dpdx(vdm_uv);
    let vdm_duvy = dpdy(vdm_uv);
    let vdm_dDx = vdm_ddu * vdm_duvx.x + vdm_ddv * vdm_duvx.y;
    let vdm_dDy = vdm_ddu * vdm_duvy.x + vdm_ddv * vdm_duvy.y;
    let vdm_sx = dpdx(inputRaw.vLocalCo) + vdm_t * vdm_dDx.x + vdm_b * vdm_dDx.y + vdm_n * vdm_dDx.z;
    let vdm_sy = dpdy(inputRaw.vLocalCo) + vdm_t * vdm_dDy.x + vdm_b * vdm_dDy.y + vdm_n * vdm_dDy.z;
    var vdm_ns = cross(vdm_sx, vdm_sy);
    vdm_ns = select(vdm_ns, -vdm_ns, dot(vdm_ns, vdm_n) < 0.0);
    var vdm_nsW = (object.normalMatrix * vec4f(vdm_ns, 0.0)).xyz;
    let vdm_nsl = length(vdm_nsW);
    if (dot(vdm_d, vdm_d) > 0.0) {
      input.vGlobalCo = vdm_pW;
      if (vdm_nsl > 1e-9) {
        input.vNormal = vdm_nsW / vdm_nsl;
      }
    }
  }
`
}

/** Mesh attribute names the VDM fragment path reads (beyond the material's own
 * requests): the UV chart + the F3 frame vertex attrs `Mesh_updateFrames`
 * maintains. Categories: UV=4, GENERIC=0 (→ FLOAT3/vec3f). */
const VDM_UV_ATTR = 'uv'
const VDM_FRAME_NORMAL_ATTR = '.frames.v.normal'
const VDM_FRAME_TANGENT_ATTR = '.frames.v.tangent'

export class WgslShaderGenerator {
  scene: unknown
  paramnames: Record<number, string>
  uniforms: Record<string, NodeSocketType>
  textures: Map<ImageBlock, number>
  requestedAttrs: Map<string, RequestedAttrDesc>
  graph: Graph<unknown> | undefined
  buf: string
  wgsl: string | undefined

  constructor(scene: unknown) {
    this.scene = scene
    this.paramnames = {}
    this.uniforms = {}
    this.textures = new Map()
    this.requestedAttrs = new Map()
    this.buf = ''

    this.paramnames[ShaderContext.GLOBALCO] = 'input.vGlobalCo'
    this.paramnames[ShaderContext.LOCALCO] = 'input.vLocalCo'
    this.paramnames[ShaderContext.SCREENCO] = 'vec3f(input.clipPos.xy, input.clipPos.z)'
    // COLOR has no fixed varying anymore — vertex color is requested by name
    // through an AttributeNode (category COLOR). Fall back to local position.
    this.paramnames[ShaderContext.COLOR] = 'vec3f(input.vLocalCo)'
  }

  getType(sock: NodeSocketType): string {
    if (sock instanceof ClosureSocket) return 'Closure'
    if (sock instanceof FloatSocket) return 'f32'
    if (sock instanceof Vec3Socket) return 'vec3f'
    if (sock instanceof Vec4Socket) return 'vec4f'
    if (sock instanceof Vec2Socket) return 'vec2f'
    if (sock instanceof Matrix4Socket) return 'mat4x4f'
    return 'f32'
  }

  getSocketName(sock: NodeSocketType): string {
    let name = sock.socketName
    name = '_' + name.trim().replace(/[ \t\n\r]/g, '_')
    name += '_' + sock.graph_id
    return name
  }

  coerce(socka: NodeSocketType, sockb: NodeSocketType): string {
    const n = this.getSocketName(socka)
    const ctorA = socka.constructor as new () => NodeSocketType
    const ctorB = sockb.constructor as new () => NodeSocketType
    if (socka instanceof ctorB || sockb instanceof ctorA) return n

    const sa = socka as NodeSocketType
    const sb = sockb as NodeSocketType

    if (sb instanceof FloatSocket) {
      if (sa instanceof Vec2Socket) return `(length(${n})/sqrt(2.0))`
      if (sa instanceof Vec3Socket) return `(length(${n})/sqrt(3.0))`
      if (sa instanceof Vec4Socket) return `(length(${n})/sqrt(4.0))`
      if (sa instanceof ClosureSocket) return `closure2float(${n})`
    } else if (sb instanceof Vec2Socket) {
      if (sa instanceof FloatSocket) return `vec2f(${n}, ${n})`
      if (sa instanceof Vec3Socket || sa instanceof Vec4Socket) return `(${n}).xy`
      if (sa instanceof ClosureSocket) return `closure2vec2(${n})`
    } else if (sb instanceof Vec3Socket) {
      if (sa instanceof FloatSocket) return `vec3f(${n}, ${n}, ${n})`
      if (sa instanceof Vec4Socket) return `(${n}).xyz`
      if (sa instanceof Vec2Socket) return `vec3f(${n}, 0.0)`
      if (sa instanceof ClosureSocket) return `closure2vec3(${n})`
    } else if (sb instanceof Vec4Socket) {
      if (sa instanceof FloatSocket) return `vec4f(${n}, ${n}, ${n}, 1.0)`
      if (sa instanceof Vec3Socket) return `vec4f(${n}, 1.0)`
      if (sa instanceof Vec2Socket) return `vec4f(${n}, 0.0, 0.0, 1.0)`
      if (sa instanceof ClosureSocket) return `closure2vec4(${n})`
    } else if (sb instanceof ClosureSocket) {
      if (sa instanceof Vec3Socket) return `vec3toclosure(${n})`
      if (sa instanceof Vec4Socket) return `vec4toclosure(${n})`
      if (sa instanceof FloatSocket) return `floattoclosure(${n})`
    }

    // eslint-disable-next-line no-console
    console.warn('WgslShaderGenerator: failed coercion', sa, sb)
    return '0.0'
  }

  /**
   * Resolve a socket to a WGSL expression. If connected, follows the edge
   * (coercing types if needed). Otherwise `fallback` decides the default:
   * a number indexes a `ShaderContext` coordinate-space varying, a string
   * is used verbatim as a WGSL expression; with no fallback an input socket
   * becomes a material uniform and an output socket its own name.
   */
  getSocketValue(sock: NodeSocketType, fallback?: number | string): string {
    if (sock.edges.length > 0 && sock.socketType === SocketTypes.INPUT) {
      const ctorA = sock.constructor as new () => NodeSocketType
      if (!(sock.edges[0] instanceof ctorA)) {
        return this.coerce(sock.edges[0], sock)
      }
      return this.getSocketValue(sock.edges[0])
    }
    if (fallback !== undefined) {
      return typeof fallback === 'number' ? this.paramnames[fallback] : fallback
    }
    if (sock.socketType === SocketTypes.INPUT) return this.getUniform(sock)
    return this.getSocketName(sock)
  }

  getUniform(sock: NodeSocketType): string {
    const name = this.getSocketName(sock)
    this.uniforms[name] = sock
    return `material.${name}`
  }

  getTexture(image: ImageBlock): string {
    if (!this.textures.has(image)) this.textures.set(image, this.textures.size)
    return `sampler_${image.lib_id}`
  }

  /**
   * Record that the material reads geometry attribute `name` (in `category`),
   * returning the WGSL expression (`input.<field>`) that reads its per-fragment
   * varying and the element type. Deduped by name; slots are assigned after the
   * full graph walk (see `_assignAttrSlots`). The renderer turns the collected
   * set into per-attribute vertex buffers handed to sculptcore.
   */
  requestAttribute(name: string, category: number): {field: string; wgslType: string} {
    let desc = this.requestedAttrs.get(name)
    if (!desc) {
      const {wgslType, gpuType, elemSize} = attrCategoryType(category)
      desc = {name, category, field: sanitizeAttrField(name), wgslType, gpuType, elemSize, slot: -1}
      this.requestedAttrs.set(name, desc)
    }
    return {field: `input.${desc.field}`, wgslType: desc.wgslType}
  }

  /** Assign each requested attribute its vertex `@location` (2 + index; 0/1 are
   * the implicit position/normal). Call once after the graph walk. */
  private _assignAttrSlots(): void {
    let i = 0
    for (const desc of this.requestedAttrs.values()) {
      desc.slot = 2 + i++
    }
  }

  /** Build the `VsIn` (vertex buffer layout) + `VsOut` (varyings) structs and
   * the `vs_main` pass-through, all sized to the requested-attribute set. This
   * is the single source of truth for the vertex interface — the C++ ShaderDef
   * attr order must match the `slot` field. */
  private _buildVertexStagesWgsl(): string {
    const attrs = [...this.requestedAttrs.values()].sort((a, b) => a.slot - b.slot)

    let vsIn = 'struct VsIn {\n'
    vsIn += '  @location(0) position : vec3f,\n'
    vsIn += '  @location(1) normal   : vec3f,\n'
    for (const a of attrs) vsIn += `  @location(${a.slot}) ${a.field} : ${a.wgslType},\n`
    vsIn += '};\n'

    let vsOut = 'struct VsOut {\n'
    vsOut += '  @builtin(position) clipPos : vec4f,\n'
    vsOut += '  @location(0) vNormal   : vec3f,\n'
    vsOut += '  @location(1) vGlobalCo : vec3f,\n'
    vsOut += '  @location(2) vLocalCo  : vec3f,\n'
    let loc = 3
    for (const a of attrs) vsOut += `  @location(${loc++}) ${a.field} : ${a.wgslType},\n`
    vsOut += '};\n'

    let passthrough = ''
    for (const a of attrs) passthrough += `  out.${a.field} = in.${a.field};\n`

    const vsMain = `
@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  let p_obj = object.objectMatrix * vec4f(in.position, 1.0);
  out.clipPos   = frame.projectionMatrix * vec4f(p_obj.xyz, 1.0);
  out.vNormal   = (object.normalMatrix * vec4f(in.normal, 0.0)).xyz;
  out.vGlobalCo = p_obj.xyz;
  out.vLocalCo  = in.position;
${passthrough}  return out;
}
`
    return `${vsIn}\n${vsOut}\n${vsMain}`
  }

  /** TESS_TIER vertex interface: position + normal inputs (the amplified and
   * finalized buffers — smooth frame normals from the X3 stage-3 pass), the
   * SAME VsOut as the normal path so the fragment body compiles unchanged;
   * every requested-attr varying default-filled (white for color-category
   * attrs, zero otherwise, mirroring sculptcore's missing-layer fills). */
  private _buildTessVertexStagesWgsl(): string {
    const attrs = [...this.requestedAttrs.values()].sort((a, b) => a.slot - b.slot)

    let vsOut = 'struct VsOut {\n'
    vsOut += '  @builtin(position) clipPos : vec4f,\n'
    vsOut += '  @location(0) vNormal   : vec3f,\n'
    vsOut += '  @location(1) vGlobalCo : vec3f,\n'
    vsOut += '  @location(2) vLocalCo  : vec3f,\n'
    let loc = 3
    for (const a of attrs) vsOut += `  @location(${loc++}) ${a.field} : ${a.wgslType},\n`
    vsOut += '};\n'

    let fills = ''
    for (const a of attrs) {
      const white = a.category === 2 && a.wgslType === 'vec4f'
      fills += `  out.${a.field} = ${white ? 'vec4f(1.0, 1.0, 1.0, 1.0)' : `${a.wgslType}()`};\n`
    }

    const vsMain = `
struct VsIn {
  @location(0) position : vec3f,
  @location(1) normal   : vec3f,
};
@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  let p_obj = object.objectMatrix * vec4f(in.position, 1.0);
  out.clipPos   = frame.projectionMatrix * vec4f(p_obj.xyz, 1.0);
  out.vNormal   = (object.normalMatrix * vec4f(in.normal, 0.0)).xyz;
  out.vGlobalCo = p_obj.xyz;
  out.vLocalCo  = in.position;
${fills}  return out;
}
`
    return `${vsOut}\n${vsMain}`
  }

  /** The collected requested-attribute set, slot-ordered. The renderengine
   * hands this to sculptcore after `generate()`. */
  getRequestedAttrs(): RequestedAttrDesc[] {
    return [...this.requestedAttrs.values()].sort((a, b) => a.slot - b.slot)
  }

  out(s: string): void {
    this.buf += s
  }

  generate(
    graph: Graph<unknown>,
    rlights: IRenderLights,
    extraDefines: Record<string, number | string | boolean> = {}
  ): this {
    this.graph = graph
    graph.sort()

    let output: OutputNode | undefined
    for (const node of graph.nodes) {
      if (node instanceof OutputNode) {
        output = node as OutputNode
        break
      }
    }
    if (!output) {
      this.wgsl = buildFallbackWgsl(!!extraDefines.WITH_SSS)
      return this
    }

    const visit: Record<number, 1> = {}
    const rec = (n: GenericNode<unknown>) => {
      if (n.graph_id in visit) return
      visit[n.graph_id] = 1
      for (const k in n.inputs) {
        for (const e of n.inputs[k].edges) rec(e.node)
      }
    }
    rec(output)

    this.buf = ''
    for (const node of graph.sortlist) {
      if (!(node.graph_id in visit)) continue
      this.out(`// ${node.constructor?.name ?? 'node'}\n`)
      for (const k in node.outputs) {
        const sock = node.outputs[k]
        const type = this.getType(sock)
        const name = this.getSocketName(sock)
        this.out(`var ${name} : ${type};\n`)
      }
      this.out('{\n')
      ;(node as ShaderNode).genWgsl(this)
      this.out('\n}\n')
    }

    // Tessellated tier (extraDefines.TESS_TIER, X3 stage 2): the draw binds
    // ONLY the amplified position buffer, so the vertex stage takes position
    // alone and default-fills every varying, and the fragment derives a flat
    // normal from screen derivatives (the stage-2 shading stopgap until the
    // smoothed-frame pass). Mutually exclusive with VDM_MODE — the VDM apply
    // moves to the amplification compute pass in stage 3.
    const tessTier = !!extraDefines.TESS_TIER

    // VDM mode (extraDefines.VDM_MODE): request the UV + frame attrs the
    // fragment sampler needs and stage the @group(3) library + fs_main
    // preamble. Unset ⇒ the emitted WGSL is bit-identical to before.
    const vdmMode = !!extraDefines.VDM_MODE && !tessTier
    let vdmDecls = ''
    let vdmPreamble = ''
    if (vdmMode) {
      this.requestAttribute(VDM_UV_ATTR, 4)
      this.requestAttribute(VDM_FRAME_NORMAL_ATTR, 0)
      this.requestAttribute(VDM_FRAME_TANGENT_ATTR, 0)
      // VDM_PTEX swaps in the per-grid-table sampler (same vdmSample seam;
      // the preamble is shared).
      vdmDecls = extraDefines.VDM_PTEX ? VDM_SAMPLE_PTEX_WGSL : VDM_SAMPLE_WGSL
      vdmPreamble = buildVdmPreamble(
        this.requestedAttrs.get(VDM_UV_ATTR)!.field,
        this.requestedAttrs.get(VDM_FRAME_NORMAL_ATTR)!.field,
        this.requestedAttrs.get(VDM_FRAME_TANGENT_ATTR)!.field
      )
    }
    // The preamble copies the immutable param into a local `var input`.
    const fsParam = vdmMode ? 'inputRaw' : 'input'

    // Attributes were collected during the walk (via requestAttribute); assign
    // their vertex slots now and build the matching VsIn/VsOut/vs_main.
    this._assignAttrSlots()
    const vertexStages = tessTier ? this._buildTessVertexStagesWgsl() : this._buildVertexStagesWgsl()

    let materialStruct = 'struct MaterialUniforms {\n'
    const fields: string[] = []
    for (const k in this.uniforms) {
      const t = this.getType(this.uniforms[k])
      fields.push(`  ${k} : ${t}`)
    }
    if (fields.length === 0) fields.push('  _unused : f32')
    materialStruct += fields.join(',\n') + ',\n};\n'
    materialStruct += '@group(1) @binding(2) var<uniform> material : MaterialUniforms;\n'

    let texdecl = ''
    let texBinding = 3
    for (const image of this.textures.keys()) {
      const key = `sampler_${image.lib_id}`
      texdecl += `@group(1) @binding(${texBinding}) var ${key}_tex : texture_2d<f32>;\n`
      texdecl += `@group(1) @binding(${texBinding + 1}) var ${key}_smp : sampler;\n`
      texBinding += 2
    }

    const lightPre = LightGenWgsl.pre()
    const defines: Record<string, number | string | boolean> = {
      ...LightGenWgsl.genDefines(rlights),
      ...extraDefines,
    }

    const wgslBody = `
${CLOSURE_WGSL}
${FRAME_UNIFORMS_WGSL}
${OBJECT_UNIFORMS_WGSL}
${lightPre}
${materialStruct}
${texdecl}${vdmDecls}
${vertexStages}
${SHADER_LIB_WGSL}

// When WITH_SSS is set, BasePass is MRT: @location(0) is the lit color,
// @location(1) carries the diffuse irradiance to scatter (rgb) + the max
// world-space scatter radius (a — kernel footprint + silhouette mask), and
// @location(2) carries the per-channel world scatter radius (rgb) so the blur
// can weight each colour band independently (red bleeds widest). Materials with
// no SSS node leave scatter/radius at 0, making the SSS chain a no-op for them.
// When WITH_SSS is unset the fragment is single-output, byte-identical to before
// SSS landed.
#ifdef WITH_SSS
struct FsOut {
  @location(0) color     : vec4f,
  @location(1) sss       : vec4f,
  @location(2) sssRadius : vec4f,
};
#endif

@fragment
#ifdef WITH_SSS
fn fs_main(${fsParam} : VsOut) -> FsOut {
#endif
#ifndef WITH_SSS
fn fs_main(${fsParam} : VsOut) -> @location(0) vec4f {
#endif
${vdmPreamble}  var _mainSurface : Closure;
  _mainSurface.diffuse      = vec3f(0.0);
  _mainSurface.light        = vec3f(0.0);
  _mainSurface.emission     = vec3f(0.0);
  _mainSurface.scatter      = vec3f(0.0);
  _mainSurface.sssRadiusVec = vec3f(0.0);
  _mainSurface.sssRadius    = 0.0;
  _mainSurface.alpha        = 1.0;

  ${this.buf.replace(/SHADER_SURFACE/g, '_mainSurface')}

  ${ALPHA_HASH_WGSL.replace(/SHADER_SURFACE/g, '_mainSurface')}

#ifdef WITH_SSS
  var out : FsOut;
  out.color     = vec4f(_mainSurface.light + _mainSurface.emission, _mainSurface.alpha);
  out.sss       = vec4f(_mainSurface.scatter, _mainSurface.sssRadius);
  out.sssRadius = vec4f(_mainSurface.sssRadiusVec, 0.0);
  return out;
#endif
#ifndef WITH_SSS
  return vec4f(_mainSurface.light + _mainSurface.emission, _mainSurface.alpha);
#endif
}
`
    // The preprocessor only handles `#ifdef`/`#define`/`#endif`; it does
    // NOT macro-expand `#define`d names inside arbitrary code lines.
    // Light templates use `MAXPLIGHT` as a literal inside
    // `array<PointLight, MAXPLIGHT>` and `li < MAXPLIGHT`, so after
    // preprocess we have to swap the integer values in by hand.
    let wgsl = preprocess(wgslBody, {defines})
    for (const [k, v] of Object.entries(defines)) {
      wgsl = wgsl.replace(new RegExp(`\\b${k}\\b`, 'g'), String(v))
    }
    this.wgsl = wgsl
    return this
  }

  /**
   * Pack material-side uniforms (`_color_42` etc) into `uniforms` for
   * `UniformBindings.write` to consume.
   */
  setMaterialUniforms(graph: Graph<unknown>, uniforms: Record<string, unknown>): void {
    for (const node of graph.sortlist) {
      for (const k in node.inputs) {
        const sock = node.inputs[k]
        if (sock.edges.length === 0) {
          const name = this.getSocketName(sock)
          if (name in this.uniforms) {
            uniforms[name] = sock.getValue() as unknown
          }
        }
      }
    }
  }

  /**
   * Seed each image node's GPU texture view + sampler into `uniforms` under
   * the `sampler_<libid>_tex` / `_smp` names the generated WGSL declares.
   * Separate from setMaterialUniforms because it needs the GPUDevice and must
   * re-run per frame (getGpuTex re-uploads when the image regenerates; the
   * view identity then changes). Not-ready images stay unseeded —
   * UniformBindings skips absent resource vars.
   */
  setTextureUniforms(device: GPUDevice, uniforms: Record<string, unknown>): void {
    for (const image of this.textures.keys()) {
      const tex = image.getGpuTex(device)
      if (!tex) {
        continue
      }
      const base = `sampler_${image.lib_id}`
      uniforms[`${base}_tex`] = tex.view
      uniforms[`${base}_smp`] = sharedLinearSampler(device)
    }
  }
}

/** One linear/repeat sampler per device — every image node shares it. */
const linearSamplers = new WeakMap<GPUDevice, GPUSampler>()
export function sharedLinearSampler(device: GPUDevice): GPUSampler {
  let smp = linearSamplers.get(device)
  if (!smp) {
    smp = device.createSampler({
      magFilter   : 'linear',
      minFilter   : 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    })
    linearSamplers.set(device, smp)
  }
  return smp
}

/** Minimal vertex interface (position+normal only) for the no-output fallback
 * shader — no requested attributes, so just the implicit slots 0/1. */
const FALLBACK_VERTEX_WGSL = `
struct VsIn {
  @location(0) position : vec3f,
  @location(1) normal   : vec3f,
};
struct VsOut {
  @builtin(position) clipPos : vec4f,
  @location(0) vNormal   : vec3f,
  @location(1) vGlobalCo : vec3f,
  @location(2) vLocalCo  : vec3f,
};
@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  let p_obj = object.objectMatrix * vec4f(in.position, 1.0);
  out.clipPos   = frame.projectionMatrix * vec4f(p_obj.xyz, 1.0);
  out.vNormal   = (object.normalMatrix * vec4f(in.normal, 0.0)).xyz;
  out.vGlobalCo = p_obj.xyz;
  out.vLocalCo  = in.position;
  return out;
}
`

function buildFallbackWgsl(withSss: boolean): string {
  const head = `
${CLOSURE_WGSL}
${FRAME_UNIFORMS_WGSL}
${OBJECT_UNIFORMS_WGSL}
${FALLBACK_VERTEX_WGSL}
`
  if (withSss) {
    // MRT-shaped fallback: BasePass has three color attachments when SSS is on,
    // so a single-output fragment would fail WGSL validation against it.
    return `${head}
struct FsOut {
  @location(0) color     : vec4f,
  @location(1) sss       : vec4f,
  @location(2) sssRadius : vec4f,
};
@fragment fn fs_main(input : VsOut) -> FsOut {
  var out : FsOut;
  out.color     = vec4f(0.0, 0.0, 0.0, 1.0);
  out.sss       = vec4f(0.0, 0.0, 0.0, 0.0);
  out.sssRadius = vec4f(0.0, 0.0, 0.0, 0.0);
  return out;
}
`
  }
  return `${head}
@fragment fn fs_main(input : VsOut) -> @location(0) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
`
}
