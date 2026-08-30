/**
 * Minimal dependency-free PNG → grayscale decoder for the screenshot A/B
 * integration gates (`sculptcore_vdm_render.test.ts`). Handles exactly what
 * Chromium's `canvas.toDataURL('image/png')` emits: 8-bit RGB/RGBA (color
 * types 2/6), non-interlaced, one IDAT stream — decoded via node:zlib inflate
 * + per-scanline unfiltering. Not a general PNG reader.
 */

import zlib from 'node:zlib'

export interface GrayImage {
  width: number
  height: number
  /** Row-major luminance, 0..255 floats. */
  data: Float32Array
}

export function decodePngGray(png: Uint8Array): GrayImage {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (png[i] !== sig[i]) throw new Error('not a PNG')
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  let width = 0
  let height = 0
  let bitDepth: number
  let colorType = 0
  const idat: Uint8Array[] = []

  let off = 8
  while (off + 8 <= png.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7])
    const dataOff = off + 8
    if (type === 'IHDR') {
      width = view.getUint32(dataOff)
      height = view.getUint32(dataOff + 4)
      bitDepth = png[dataOff + 8]
      colorType = png[dataOff + 9]
      const interlace = png[dataOff + 12]
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace})`)
      }
    } else if (type === 'IDAT') {
      idat.push(png.subarray(dataOff, dataOff + len))
    } else if (type === 'IEND') {
      break
    }
    off = dataOff + len + 4 // skip CRC
  }
  if (!width || !height || idat.length === 0) throw new Error('malformed PNG')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp

  // Undo per-scanline filters (types 0-4) in place on a copy.
  const out = new Uint8Array(width * height * bpp)
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const rawV = raw[src + x]
      const left = x >= bpp ? out[dst + x - bpp] : 0
      const up = y > 0 ? out[dst + x - stride] : 0
      const upLeft = y > 0 && x >= bpp ? out[dst + x - bpp - stride] : 0
      let v: number
      switch (filter) {
        case 0:
          v = rawV
          break
        case 1:
          v = rawV + left
          break
        case 2:
          v = rawV + up
          break
        case 3:
          v = rawV + ((left + up) >> 1)
          break
        case 4:
          v = rawV + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`bad PNG filter ${filter}`)
      }
      out[dst + x] = v & 0xff
    }
  }

  const gray = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const p = i * bpp
    gray[i] = 0.2126 * out[p] + 0.7152 * out[p + 1] + 0.0722 * out[p + 2]
  }
  return {width, height, data: gray}
}

/** Mean |a - b| over all pixels (images must be same-sized). */
export function meanAbsDiff(a: GrayImage, b: GrayImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  let sum = 0
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i])
  return sum / a.data.length
}

/**
 * Normalized cross-correlation of two response images (each already a diff
 * against the shared baseline). 1 = identical shading response up to scale,
 * 0 = uncorrelated. Zero-variance inputs return 0.
 */
export function ncc(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('length mismatch')
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma
    const db = b[i] - mb
    sab += da * db
    saa += da * da
    sbb += db * db
  }
  const denom = Math.sqrt(saa * sbb)
  return denom > 0 ? sab / denom : 0
}

/** Per-pixel difference image `a - b` (same-sized). */
export function diffImage(a: GrayImage, b: GrayImage): Float32Array {
  if (a.width !== b.width || a.height !== b.height) throw new Error('size mismatch')
  const out = new Float32Array(a.data.length)
  for (let i = 0; i < a.data.length; i++) out[i] = a.data[i] - b.data[i]
  return out
}
