import {LightTypes} from '../light/light.js'
import {Vector3, Matrix4} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as webgl from '../webgl/webgl.js'

import * as bluenoise from './bluenoise_mask.js'

export const ClosureGLSL = `
struct Closure {
  vec3 diffuse;
  vec3 light;
  vec3 emission;
  vec3 scatter;
  float alpha;
};
`

import type {RenderLight} from '../renderengine/renderengine_realtime.js'

export type IRenderLights = Record<string, RenderLight>

export const LightGenerators: LightGen[] = []

interface LightGenArgs {
  uniformName: string
  lightType: number
  name: string
  totname: string
  pre: string
  lightLoop: string
  getLightVector: (co: string, i: string) => string
  defines: string[]
}

export class LightGen {
  uniformName: string
  lightType: number
  name: string
  totname: string
  pre: string
  lightLoop: string
  getLightVector: (co: string, i: string) => string
  defines: string[]

  constructor(args: LightGenArgs) {
    this.uniformName = args.uniformName
    this.lightType = args.lightType
    this.name = args.name
    this.totname = args.totname
    this.pre = args.pre
    this.lightLoop = args.lightLoop
    this.getLightVector = args.getLightVector
    this.defines = args.defines
  }

  static setUniforms(
    gl: WebGL2RenderingContext,
    uniforms: Record<string, unknown>,
    scene: unknown,
    renderlights: IRenderLights = {},
    use_jitter = false,
    seed = 0.0
  ) {
    const p = new Vector3()
    const r = new Vector3()

    if (use_jitter) {
      util.seed(seed)
    }

    for (const gen of LightGenerators) {
      let i = 0

      for (const k in renderlights) {
        const rlight = renderlights[k]
        const light = rlight.light

        if (light.data.type !== gen.lightType) {
          continue
        }

        const mat = light.outputs.matrix.getValue() as Matrix4
        const m = (mat as unknown as {$matrix: Record<string, number>}).$matrix
        const dir = new Vector3([m.m31, m.m32, m.m33])

        const uname = gen.uniformName + `[${i}]`
        i++

        p.zero()
        p.multVecMatrix(mat)

        if (use_jitter) {
          switch (light.data.type) {
            case LightTypes.SUN:
              uniforms[uname + '.dir'] = dir
            // falls through
            case LightTypes.AREA_DISK:
            case LightTypes.AREA_RECT:
            case LightTypes.POINT:
            default:
              r[0] = (util.random() - 0.5) * 2.0
              r[1] = (util.random() - 0.5) * 2.0
              r[2] = (util.random() - 0.5) * 2.0

              r.mulScalar(light.data.inputs.radius.getValue() as number)
              p.add(r)

              break
          }
        }

        uniforms[uname + '.co'] = p
        uniforms[uname + '.power'] = light.data.inputs.power.getValue()
        uniforms[uname + '.radius'] = light.data.inputs.radius.getValue()
        uniforms[uname + '.distance'] = light.data.inputs.distance.getValue()
        uniforms[uname + '.color'] = light.data.inputs.color.getValue()

        // Shadow-map slots were dropped when the realtime engine moved
        // to WebGPU-only — see `renderengine_realtime.ts`. This GL-side
        // helper is only used by the node-editor preview which never
        // wires shadows.
      }
    }
  }

  genDefines(rlights: IRenderLights) {
    let tot = 0

    for (const k in rlights) {
      const rlight = rlights[k]
      const light = rlight.light

      if (light.data.type === this.lightType) {
        tot++
      }
    }

    if (tot === 0) return ''

    return `#define ${this.totname} ${tot}\n`
  }

  static genDefines(rlights: IRenderLights) {
    let ret = ''

    for (const gen of LightGenerators) {
      ret += gen.genDefines(rlights) + '\n'
    }

    return ret
  }

  gen(closure: string, co: string, normal: string, color: string, brdf: string) {
    let code = this.lightLoop

    code = code.replace(/CLOSURE/g, closure)
    code = code.replace(/CO/g, co)
    code = code.replace(/NORMAL/g, normal)
    code = code.replace(/COLOR/g, color)
    code = code.replace(/BRDF/g, brdf)

    return code
  }

  static register(generator: LightGen) {
    LightGenerators.push(generator)
  }

  static pre() {
    let ret = ''

    for (const gen of LightGenerators) {
      ret += gen.pre + '\n'
    }

    return ret
  }

  static generate(closure: string, co: string, normal: string, color: string, brdf: string) {
    let ret = ''
    for (const gen of LightGenerators) {
      ret += gen.gen(closure, co, normal, color, brdf) + '\n'
    }

    ret += ShaderFragments.AMBIENT.replace(/CLOSURE/g, closure)

    return ret
  }
}

export const PointLightCode = new LightGen({
  lightType  : LightTypes.POINT,
  name       : 'POINTLIGHT',
  uniformName: 'POINTLIGHTS',
  totname    : 'MAXPLIGHT',
  pre: `
  #if defined(MAXPLIGHT) && MAXPLIGHT > 0
    #define HAVE_POINTLIGHT
    //define HAVE_SHADOW
    
    struct PointLight {
      vec3 co;
      float power;
      float radius; //soft shadow radius
      vec3 color;
      float distance; //falloff distance
#ifdef HAVE_SHADOW
      samplerCubeShadow shadow;
#endif
      float shadow_near;
      float shadow_far;
    };
    
    uniform PointLight POINTLIGHTS[MAXPLIGHT];
  #endif
  `,

  //inputs: CLOSURE CO NORMAL COLOR (for BRDF)
  lightLoop: `
  #ifdef HAVE_POINTLIGHT
    for (int li=0; li<MAXPLIGHT; li++) {
      vec3 lvec = normalize(POINTLIGHTS[li].co - CO);
      vec3 ln = normalize(lvec);
      
      BRDF;

      vec3 f = brdf_out * dot(ln, NORMAL);
      
      float energy = 1.0 / (1.0 + sqrt(length(lvec)/POINTLIGHTS[li].distance));
      energy *= POINTLIGHTS[li].power;
     
#ifdef HAVE_SHADOW
      float z = 1.0/length(lvec) - 1.0/POINTLIGHTS[li].shadow_near;
      z /= 1.0/POINTLIGHTS[li].shadow_far - 1.0/POINTLIGHTS[li].shadow_near;
      
      z = length(lvec);
      
      vec4 sp = vec4(lvec, z);
      
      float shadow = texture(POINTLIGHTS[li].shadow, sp);
#else
      float shadow = 1.0;
#endif
  
      CLOSURE.light += f * POINTLIGHTS[li].color * energy * shadow;
      //CLOSURE.light += vec3(shadow, shadow, shadow);
    }
  #endif
  `,

  defines: ['MAXPLIGHT'],

  getLightVector: function (co, i) {
    return `normalize(POINTLIGHTS${i}.co - ${co})`
  },
})
LightGen.register(PointLightCode)

export const SunLightCode = new LightGen({
  lightType  : LightTypes.SUN,
  name       : 'SUNLIGHT',
  uniformName: 'SUNLIGHTS',
  totname    : 'MAXSLIGHT',
  pre: `
  #if defined(MAXSLIGHT) && MAXSLIGHT > 0
    #define HAVE_SUNLIGHT
    //define HAVE_SHADOW
    
    struct SUNLight {
      vec3 co;
      vec3 dir;
      float power;
      float radius; //soft shadow radius
      vec3 color;
      float distance; //falloff distance
#ifdef HAVE_SHADOW
      samplerCubeShadow shadow;
#endif
      float shadow_near;
      float shadow_far;
    };
    
    uniform SUNLight SUNLIGHTS[MAXSLIGHT];
  #endif
  `,

  //inputs: CLOSURE CO NORMAL COLOR (for BRDF)
  lightLoop: `
  #ifdef HAVE_SUNLIGHT
    for (int li=0; li<MAXSLIGHT; li++) {
      vec3 lvec = SUNLIGHTS[li].dir;
      vec3 ln = normalize(lvec);
      
      BRDF;

      vec3 f = brdf_out * max(dot(ln, NORMAL), 0.0);
      
      float energy = SUNLIGHTS[li].power;
     
#ifdef HAVE_SHADOW
      float z = 1.0/length(lvec) - 1.0/SUNLIGHTS[li].shadow_near;
      z /= 1.0/SUNLIGHTS[li].shadow_far - 1.0/SUNLIGHTS[li].shadow_near;
      
      z = length(lvec);
      
      vec4 sp = vec4(lvec, z);
      
      float shadow = texture(SUNLIGHTS[li].shadow, sp);
#else
      float shadow = 1.0;
#endif
  
      CLOSURE.light += f * SUNLIGHTS[li].color * energy * shadow;
      //CLOSURE.light += vec3(shadow, shadow, shadow);
    }
  #endif
  `,

  defines: ['MAXSLIGHT'],

  getLightVector: function (co, i) {
    return `SUNLIGHTS${i}.dir`
  },
})
LightGen.register(SunLightCode)

export class BRDFGen {
  code: string

  constructor(code: string) {
    this.code = code
  }

  gen(closure: string, co: string, normal: string, color: string) {
    let code = this.code.replace(/CLOSURE/g, closure)

    code = code.replace(/COLOR/g, color)
    code = code.replace(/CO/g, co)
    code = code.replace(/NORMAL/g, normal)

    return code
  }
}

//inputs CLOSURE ln lvec NORMAL CO COLOR
export const DiffuseBRDF = new BRDFGen(`
  vec3 brdf_out = COLOR.rgb;
`)

export const ShaderFragments = {
  ALPHA_HASH: `
    {
      vec3 camera = (normalMatrix * vec4(vGlobalCo, 1.0)).xyz;
      float prob = hash3f(vec3(gl_FragCoord.xy, camera.z*0.01));
      
      if (prob > SHADER_SURFACE.alpha) {
        discard;
      }
    }
  `,
  AMBIENT: ` //inputs: CLOSURE
#ifdef WITH_AO
    {
    float aopass1 = texture2D(passAO, gl_FragCoord.xy/viewportSize)[0];
    vec3 aopass = vec3(aopass1, aopass1, aopass1);
    
    CLOSURE.light += CLOSURE.diffuse*aopass*ambientColor*ambientPower;
    //CLOSURE.light = ambientColor;
    }
#else
    CLOSURE.light += CLOSURE.diffuse*ambientColor*ambientPower;
#endif
  `,
  CLOSUREDEF: ClosureGLSL,
  ATTRIBUTES: `
attribute vec3 position;
attribute vec3 normal;
MULTILAYER_UV_DECLARE
attribute vec4 color;
attribute float id;
`,
  UNIFORMS: `
uniform mat4 projectionMatrix;
uniform mat4 objectMatrix;
uniform mat4 normalMatrix;
uniform float object_id;
uniform vec2 viewportSize;

uniform sampler2D passAO;

uniform vec3 ambientColor;
uniform float ambientPower;

uniform float uSample;

`,
  VARYINGS: `
    varying vec4 vColor;
    varying vec3 vNormal;
    varying float vId;
    varying vec3 vGlobalCo;
    varying vec3 vLocalCo;
  `,
  SHADERLIB: `

float hash1f(float seed) {
  seed += uSample;
  
  seed = fract(seed*0.25234 + seed*sqrt(11.0));
  return fract(1.0 / (0.00001 + 0.00001*fract(seed)));
}

float hash2f(vec2 p) {
  float seed = p.y*sqrt(3.0) + p.x*sqrt(5.0);
  //seed += fract(p.x*p.y);
  
  return fract(seed+uSample*sqrt(2.0));
  return hash1f(seed);
}

float hash3f(vec3 p) {
  float seed = p.y*sqrt(3.0) + p.x*sqrt(5.0);
  seed += fract(p.z*sqrt(11.0));
  //seed += fract(p.x*p.y);
  
  return fract(seed+uSample*sqrt(2.0));
  return hash1f(seed);
}

Closure vec3toclosure(vec3 c) {
  Closure ret;
  
  ret.alpha = 1.0;
  ret.emission = c;
  
  return ret;
}

Closure vec4toclosure(vec4 c) {
  Closure ret;
  
  ret.alpha = c[3];
  ret.emission = c.rgb;
  
  return ret;
}

Closure floattoclosure(float c) {
  Closure ret;
  
  ret.alpha = 1.0;
  ret.emission = vec3(c, c, c);
  
  return ret;
}

`,
}

export interface IBlueMask {
  tex: webgl.Texture | undefined //
  gl: WebGL2RenderingContext | undefined
  shaderPre: string
  width: number
  height: number
}

const bluemask: IBlueMask = {
  tex      : undefined,
  gl       : undefined,
  width    : 0,
  height   : 0,
  shaderPre: `
  uniform sampler2D blueMask;
  uniform vec2 blueUVOff;
  uniform vec2 blueUVScale;
  
  /*
  float _hashrand(float f) {
    f = fract((f + f*0.1 + f*1000.0)*sqrt(3.0));
    return fract(1.0 / (f*0.00001 + 0.000001));
  }*/
  
  vec4 sampleBlue(vec2 uv) {
    return texture2D(blueMask, uv*blueUVScale + blueUVOff);
  }
    
  `,
}

export function getBlueMaskDef() {
  return bluemask
}

/*
 * Get a four-component blue noise mask.
 * Each component is blue-corralated with the others,
 * so it's four seperate but related masks.
 *
 * Use each component for different shading parameters,
 * e.g. one for AO, one for subsurface scattering, etc, etc
 * */
export function getBlueMask(gl: WebGL2RenderingContext): IBlueMask {
  if (!gl) {
    throw new Error('gl cannot be undefined')
  }

  if (bluemask.gl === gl) {
    return bluemask
  }

  bluemask.gl = gl
  const btex = new webgl.Texture()
  bluemask.tex = btex
  btex.texture = gl.createTexture()

  //convert to float data
  //
  const mask = bluenoise.cmyk
  const data = mask.mask
  const size = mask.dimen
  const comps = mask.components

  const tex = new Float32Array(size * size * 4)

  let maxelem = mask.bytesPerPixel / mask.components
  maxelem = (1 << (maxelem * 8)) - 1

  if (maxelem !== 255) {
    throw new Error('' + maxelem)
  }

  for (let i = 0; i < size * size; i++) {
    const idx1 = i * comps
    const idx2 = i * 4

    if (comps < 3) {
      tex[idx2 + 3] = 1.0
    }

    for (let j = 0; j < comps; j++) {
      const f = data[idx1 + j] / maxelem
      tex[idx2 + j] = f
    }
  }

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, btex.texture ?? null)
  btex.texImage2D(gl, gl.TEXTURE_2D, 0, gl.RGBA32F, ~~size, ~~size, 0, gl.RGBA, gl.FLOAT, tex)
  //gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ~~size, ~~size, 0, gl.RGBA, gl.FLOAT, null);
  //bluemask.tex.load(gl, size, size, tex);

  btex.texParameteri(gl, gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  btex.texParameteri(gl, gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  btex.texParameteri(gl, gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  btex.texParameteri(gl, gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)

  bluemask.width = bluemask.height = size

  return bluemask
}

const _rand = new util.MersenneRandom()

export function setBlueUniforms(
  uniforms: Record<string, unknown>,
  viewport_size: number[],
  bluetex: IBlueMask,
  uSample = 0.0
) {
  const size = viewport_size

  _rand.seed(uSample)

  uniforms.blueUVOff = [_rand.random(), _rand.random()]
  uniforms.blueMask = bluetex.tex
  uniforms.blueUVScale = [size[0] / bluetex.width, size[1] / bluetex.height]
}
