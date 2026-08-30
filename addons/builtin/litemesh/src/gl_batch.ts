import {Buffer, DrawBatch, DrawCommand, ShaderDef} from '@sculptcore/api'
import {} from '@litestl/typescript-runtime'
import {GPUType} from '@sculptcore/api/sculptcore/gpu/GPUType'
import {GPUBufferType} from '@sculptcore/api/sculptcore/gpu/GPUBufferType'
import {GPUCmdType} from '@sculptcore/api/sculptcore/gpu/GPUCmdType'
import {IWasmInterface} from '@sculptcore/api/api'
import {type IUniformsBlock, type ShaderProgram} from '@framework/api'

interface BoundLike {
  ptr: number
}

interface CachedBuffer {
  glBuf: WebGLBuffer
  uploadedSize: number
  uploadedDataPtr: number
}

function gpuTypeBytes(t: GPUType): number {
  switch (t) {
    case GPUType.FLOAT16:
    case GPUType.INT16:
    case GPUType.UINT16:
      return 2
    case GPUType.FLOAT32:
    case GPUType.INT32:
    case GPUType.UINT32:
      return 4
    case GPUType.FLOAT64:
      return 8
    case GPUType.INT8:
    case GPUType.UINT8:
      return 1
    default:
      return 4
  }
}

function gpuTypeGL(gl: WebGL2RenderingContext, t: GPUType): GLenum {
  switch (t) {
    case GPUType.FLOAT32:
      return gl.FLOAT
    case GPUType.FLOAT16:
      return gl.HALF_FLOAT
    case GPUType.INT32:
      return gl.INT
    case GPUType.INT16:
      return gl.SHORT
    case GPUType.INT8:
      return gl.BYTE
    case GPUType.UINT32:
      return gl.UNSIGNED_INT
    case GPUType.UINT16:
      return gl.UNSIGNED_SHORT
    case GPUType.UINT8:
      return gl.UNSIGNED_BYTE
    default:
      return gl.FLOAT
  }
}

function bufferTargetGL(gl: WebGL2RenderingContext, t: GPUBufferType): GLenum {
  return t === GPUBufferType.BUFFER_INDEX ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER
}

function cmdTypeGL(gl: WebGL2RenderingContext, t: GPUCmdType): GLenum {
  switch (t) {
    case GPUCmdType.DRAW_TRIS:
      return gl.TRIANGLES
    case GPUCmdType.DRAW_TRI_STRIP:
      return gl.TRIANGLE_STRIP
    case GPUCmdType.DRAW_LINES:
      return gl.LINES
    case GPUCmdType.DRAW_POINTS:
      return gl.POINTS
    default:
      return gl.TRIANGLES
  }
}

export class WebGLBatchExecutor {
  gl: WebGL2RenderingContext
  wasm: IWasmInterface
  private bufferCache = new Map<number, CachedBuffer>()
  private vao: WebGLVertexArrayObject
  private shader: ShaderProgram

  constructor(gl: WebGL2RenderingContext, wasm: IWasmInterface, shader: ShaderProgram) {
    this.gl = gl
    this.wasm = wasm
    this.vao = gl.createVertexArray()!
    this.shader = shader
  }

  private uploadBuffer(buf: Buffer): WebGLBuffer {
    const gl = this.gl
    const ptr = (buf as unknown as BoundLike).ptr
    const dataPtr = buf.data
    const size = buf.size
    const elemsize = buf.elemsize
    const bytes = size * elemsize * gpuTypeBytes(buf.type)

    let cached = this.bufferCache.get(ptr)
    if (cached === undefined) {
      cached = {glBuf: gl.createBuffer()!, uploadedSize: -1, uploadedDataPtr: -1}
      this.bufferCache.set(ptr, cached)
    }

    if (cached.uploadedSize !== bytes || cached.uploadedDataPtr !== dataPtr || buf.update_buffer) {
      const view = new Uint8Array(this.wasm.HEAPU8.buffer, dataPtr, bytes)
      const target = bufferTargetGL(gl, buf.target)
      gl.bindBuffer(target, cached.glBuf)
      gl.bufferData(target, view, gl.STATIC_DRAW)
      cached.uploadedSize = bytes
      cached.uploadedDataPtr = dataPtr
      buf.update_buffer = false
    }

    return cached.glBuf
  }

  releaseBuffer(buf: Buffer) {
    const ptr = (buf as unknown as BoundLike).ptr
    const cached = this.bufferCache.get(ptr)
    if (cached) {
      this.gl.deleteBuffer(cached.glBuf)
      this.bufferCache.delete(ptr)
    }
  }

  getShader(sdef: ShaderDef): ShaderProgram {
    throw new Error('old webgl code invoked')
  }

  dispatch(batch: DrawBatch, uniforms: IUniformsBlock) {
    const gl = this.gl
    const commands = batch.commands
    if (commands.length === 0) {
      return
    }

    this.shader.bind(gl, uniforms)

    gl.bindVertexArray(this.vao)

    const findAttr = (s: string, cmd: DrawCommand) => {
      for (const attr of cmd.attrs) {
        if (s === attr.name) {
          return attr
        }
      }
    }

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]

      let shader = this.shader

      if (cmd.shader !== undefined) {
        shader = this.getShader(cmd.shader)
      }
      shader.bind(gl, uniforms)

      for (const attrName of shader.attrs) {
        const attr = findAttr(attrName, cmd)
        if (attr === undefined) {
          // eslint-disable-next-line no-console
          console.log('Could not find shader attribute', attrName)
          continue
        }
        const bindLoc = shader.attrLoc(attr.name)
        const glBuf = this.uploadBuffer(attr)

        gl.bindBuffer(gl.ARRAY_BUFFER, glBuf)
        gl.enableVertexAttribArray(bindLoc)
        gl.vertexAttribPointer(bindLoc, attr.elemsize, gpuTypeGL(gl, attr.type), false, 0, 0)
      }

      const count = cmd.end - cmd.start
      gl.drawArrays(cmdTypeGL(gl, cmd.type), cmd.start, count)
    }

    gl.bindVertexArray(null)
  }

  dispose() {
    const gl = this.gl
    for (const cached of this.bufferCache.values()) {
      gl.deleteBuffer(cached.glBuf)
    }
    this.bufferCache.clear()
    gl.deleteVertexArray(this.vao)
  }
}
