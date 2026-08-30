import {PropTypes} from '../path.ux/scripts/pathux.js'
import * as mathl from '../mathl/index'
import {TextureShader} from './texture_base'

const proptypemap = {
  [PropTypes.INT]  : 'int',
  [PropTypes.FLOAT]: 'float',
  [PropTypes.VEC3] : 'vec3',
  [PropTypes.VEC2] : 'vec2',
  [PropTypes.VEC4] : 'vec4',
} as const

export const compileCache = new Map<string, mathl.CompiledJS>()

export function compileTexShaderJS(shader: TextureShader): mathl.CompiledJS {
  let code = shader.genCode()
  const sdef = shader.constructor.textureDefine()

  let uniforms = ''

  for (const k in sdef.uniforms) {
    const prop = sdef.uniforms[k]
    const type = proptypemap[prop.type as keyof typeof proptypemap]

    if (!type) {
      // eslint-disable-next-line no-console
      console.log(shader, k, prop)
      // eslint-disable-next-line no-console
      console.warn('Failed to set up uniform ' + k + ' from ToolProperty class ' + prop.constructor.name)
      continue
    }

    uniforms += `uniform ${type} ${k};\n`
  }

  code = `precision highp float;
  
in vec3 Point;
in vec3 Normal;
in float Time;

out float Value;
out vec4 Color;
out vec3 Normal;

${uniforms}

${sdef.fragmentPre}

${code}

void main() {
  Value = fsample(Point, Normal, Time, Color);
}
`

  if (compileCache.has(code)) {
    return compileCache.get(code)!
  }

  const shaderjs = mathl.compileJS(code, shader.typeName)
  compileCache.set(code, shaderjs)
  return shaderjs
}

declare global {
  interface Window {
    _testTexShaders: () => unknown
  }
  const _testTexShaders: () => unknown
}

window._testTexShaders = function () {
  const texCls = TextureShader.getTextureClass('worley')!
  const tex = new texCls()
  const result = compileTexShaderJS(tex)

  return result
}
