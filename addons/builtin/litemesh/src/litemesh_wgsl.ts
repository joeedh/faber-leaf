/**
 * WGSL ports of the sculptcore spatial shaders that LiteMesh draws
 * through. Sourced from `sculptcore/source/spatial/shaders/spatial_shaders.cc`.
 *
 * Binding convention differs from `scripts/shaders/wgsl_shaders.ts`:
 * sculptcore's `WebGPUBatchExecutor` only binds `@group(0)` per draw, so
 * `drawMatrix`/`normalMatrix`/`uColor` are packed into a single
 * `SpatialUniforms` struct at `@group(0) @binding(0)`. The matching
 * uniform-buffer write happens through `UniformBindings` (reflection
 * pairs the WGSL field names to the loose uniforms block).
 *
 * `wgslForSpatialShader` dispatches by `ShaderDef.name` — the C++ side
 * names both shaders ("Basic Mesh Shader" / "Basic Line Shader") and
 * those strings round-trip through the wasm binding system unchanged.
 */

import type {ShaderDef} from '@sculptcore/api'

/** Overlay depth bias (polygonOffset-style): pull the vertex toward the viewer
 * by a fraction of the REMAINING clip range, `z -= BIAS * (w - z)`. Perspective
 * depth is hyperbolic — (w-z)/w ~ near/dist — so this scales with the local
 * depth-buffer resolution like glPolygonOffset's units term: a constant NDC
 * offset instead either z-fights up close or pulls back-side lines through the
 * surface at distance. WebGPU's pipeline depthBias only applies to triangle
 * topologies, so the line/point overlays bias in the vertex shader; the
 * geometry itself sits exactly on the surface (no model-space push-out). */
export const OVERLAY_DEPTH_BIAS = '5e-3'

export const SPATIAL_BASIC_LINE_WGSL = `
struct SpatialUniforms {
  drawMatrix : mat4x4f,
  uColor     : vec4f,
};
@group(0) @binding(0) var<uniform> spatial : SpatialUniforms;

struct VsIn {
  @location(0) position : vec3f,
  @location(1) color    : vec4f,
};

struct VsOut {
  @builtin(position) clipPos : vec4f,
  @location(0) vColor : vec4f,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  var clip = spatial.drawMatrix * vec4f(in.position, 1.0);
  clip.z = clip.z - ${OVERLAY_DEPTH_BIAS} * (clip.w - clip.z);
  out.clipPos = clip;
  out.vColor = in.color;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  return spatial.uColor * in.vColor;
}
`

export const SPATIAL_BASIC_MESH_WGSL = `
struct SpatialUniforms {
  drawMatrix   : mat4x4f,
  normalMatrix : mat4x4f,
  uColor       : vec4f,
};
@group(0) @binding(0) var<uniform> spatial : SpatialUniforms;

struct VsIn {
  @location(0) position : vec3f,
  // The C++ ShaderDef declares 'normal' with elemsize 4, so the
  // executor binds a float32x4 buffer here even though only .xyz is
  // read. Keep this as vec4f to match the vertex layout.
  @location(1) normal   : vec4f,
  // @location(2): per-vertex color (float32x4), written by the color
  // paint brush. Defaults to white until the mesh has a color attr.
  @location(2) color    : vec4f,
};

struct VsOut {
  @builtin(position) clipPos : vec4f,
  @location(0) vNormal : vec3f,
  @location(1) vColor  : vec4f,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  out.clipPos = spatial.drawMatrix * vec4f(in.position, 1.0);
  let n = spatial.normalMatrix * vec4f(in.normal.xyz, 0.0);
  out.vNormal = normalize(n.xyz);
  out.vColor = in.color;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  let no = in.vNormal;
  let f1 = dot(no, normalize(vec3f(0.1, 0.2, -1.0)));
  var f = f1;
  if (f1 < 0.0) { f = -f1 * 0.2; }
  f = f * 0.8 + 0.2;

  var vcolor = in.vColor * spatial.uColor;
  if (f1 < 0.0) {
    vcolor.z = vcolor.z * 0.8;
    vcolor.x = vcolor.x * 0.5;
  }
  // Surface is opaque — never let a per-vertex attr alpha make it transparent.
  return vec4f(vcolor.rgb * f, 1.0);
}
`

/** Billboard point-sprite overlay (box-modeling vertex points). Mirrors
 * sculptcore/source/spatial/shaders/point_sprite.wgsl — keep them in sync. */
export const SPATIAL_POINT_SPRITE_WGSL = `
struct PointUniforms {
  drawMatrix   : mat4x4f,
  uColor       : vec4f,
  viewportSize : vec4f,
};
@group(0) @binding(0) var<uniform> u : PointUniforms;

struct VsIn {
  @location(0) position : vec3f,
  @location(1) corner   : vec2f,
  @location(2) color    : vec4f,
};

struct VsOut {
  @builtin(position) clipPos : vec4f,
  @location(0) vColor  : vec4f,
  @location(1) vCorner : vec2f,
};

const PT_HALF_PX : f32 = 4.0;

@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  var clip = u.drawMatrix * vec4f(in.position, 1.0);
  let ndcPerPx = vec2f(2.0, 2.0) / max(u.viewportSize.xy, vec2f(1.0, 1.0));
  clip = vec4f(clip.xy + in.corner * PT_HALF_PX * ndcPerPx * clip.w, clip.zw);
  clip.z = clip.z - ${OVERLAY_DEPTH_BIAS} * (clip.w - clip.z);
  out.clipPos = clip;
  out.vColor = in.color;
  out.vCorner = in.corner;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  if (dot(in.vCorner, in.vCorner) > 1.0) {
    discard;
  }
  return u.uColor * in.vColor;
}
`

export function wgslForSpatialShader(sdef: ShaderDef): string {
  const name = sdef.name
  if (name === 'Basic Mesh Shader') return SPATIAL_BASIC_MESH_WGSL
  if (name === 'Basic Line Shader') return SPATIAL_BASIC_LINE_WGSL
  if (name === 'Basic Point Shader') return SPATIAL_POINT_SPRITE_WGSL
  // The tree's dynamic material draw shader (SpatialTree.setDrawShader, M6):
  // the renderengine compiled the material's WGSL and C++ stored it on the
  // ShaderDef's `wgslSource`. Read it straight back — the attr layout in
  // `sdef.attrs` already matches the requested set, so batch.ts binds by name.
  if (name === 'Spatial Material Shader') {
    const wgsl = sdef.wgslSource
    if (wgsl && wgsl.length > 0) return wgsl
    // setDrawShader not yet called (or empty) — fall back so the frame still
    // renders rather than throwing on the draw seam.
    return SPATIAL_BASIC_MESH_WGSL
  }
  throw new Error(
    `litemesh_wgsl: no WGSL port registered for sculptcore ShaderDef "${name}". ` + `Add it to litemesh_wgsl.ts.`
  )
}
