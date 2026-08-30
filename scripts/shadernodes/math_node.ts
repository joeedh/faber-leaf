import {nstructjs, Container, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import {ShaderNetworkClass, ShaderNode} from './shader_nodes.js'
import type {WgslShaderGenerator} from './shader_nodes_wgsl.js'
import type {StructReader} from '../path.ux/scripts/util/nstructjs.js'
import {FloatSocket} from '../core/graphsockets.js'

export const MathNodeFuncs = {
  ADD  : 0,
  SUB  : 1,
  MUL  : 2,
  DIV  : 3,
  POW  : 4,
  SQRT : 5,
  FLOOR: 6,
  CEIL : 7,
  MIN  : 8,
  MAX  : 9,
  FRACT: 10,
  TENT : 11,
  COS  : 12,
  SIN  : 13,
  TAN  : 14,
  ACOS : 15,
  ASIN : 16,
  ATAN : 17,
  ATAN2: 18,
  LOG  : 19,
  EXP  : 20,
}

const mf = MathNodeFuncs
export const WgslMathSnippets: Record<number, string> = {
  [mf.ADD]  : 'A + B',
  [mf.SUB]  : 'A - B',
  [mf.MUL]  : 'A * B',
  [mf.DIV]  : 'A / B',
  [mf.POW]  : 'pow(A, B)',
  [mf.SQRT] : 'sqrt(A)',
  [mf.FLOOR]: 'floor(A)',
  [mf.CEIL] : 'ceil(A)',
  [mf.MIN]  : 'min(A, B)',
  [mf.MAX]  : 'max(A, B)',
  [mf.FRACT]: 'fract(A)',
  [mf.TENT] : 'abs(fract(A) - 0.5) * 2.0',
  [mf.COS]  : 'cos(A)',
  [mf.SIN]  : 'sin(A)',
  [mf.TAN]  : 'tan(A)',
  [mf.ACOS] : 'acos(A)',
  [mf.ASIN] : 'asin(A)',
  [mf.ATAN] : 'atan(A)',
  [mf.ATAN2]: 'atan2(B, A)',
  [mf.LOG]  : 'log(A)',
  [mf.EXP]  : 'exp(A)',
}

export class MathNode extends ShaderNode {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
shader.MathNode {
  mathFunc : int;
}`
  )

  mathFunc: number

  constructor() {
    super()

    this.mathFunc = MathNodeFuncs.MUL
  }

  buildUI(container: Container) {
    container.prop('mathFunc')
  }

  static graphDefineAPI(api: DataAPI, nstruct: DataStruct) {
    nstruct.enum('mathFunc', 'mathFunc', MathNodeFuncs, 'Function', 'Math function to use')
  }

  genWgsl(gen: WgslShaderGenerator) {
    const snippet = WgslMathSnippets[this.mathFunc] ?? 'A'

    gen.out(`
      let A : f32 = ${gen.getSocketValue(this.inputs.a)};
      let B : f32 = ${gen.getSocketValue(this.inputs.b)};
      ${gen.getSocketName(this.outputs.value)} = ${snippet};
    `)
  }

  static nodedef() {
    return {
      category: 'Math',
      name    : 'math',
      uiname  : 'Math',
      inputs: {
        a: new FloatSocket(),
        b: new FloatSocket(),
      },
      outputs: {
        value: new FloatSocket(),
      },
    }
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    super.loadSTRUCT(reader)
    /*
    if (this.inputs.color instanceof Vec4Socket) {
      let sock = new RGBASocket();
      this.inputs.color.copyTo(sock);
      sock.graph_id = this.inputs.color.graph_id;
      sock.edges = this.inputs.color.edges;

      this.inputs.color = sock;
    }//*/
  }
}

ShaderNetworkClass.register(MathNode)
