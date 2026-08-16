/**
 * Dependency-free LZ4 block (de)compressor + the sculptcore mesh-blob framing
 * (autosave plan §5.1). The autosave worker runs lz4 compression off the main
 * thread without loading the sculptcore addon, so the codec lives here as plain
 * JS that any thread can import.
 *
 * The block format is the canonical LZ4 block layout, so blocks this encoder
 * produces are decoded byte-for-byte by the C++ `LZ4_decompress_safe` in
 * `serial::readMesh` (and vice-versa). `compressMeshBlob` / `splitMeshBlob`
 * wrap/unwrap the C++ `serial::writeMesh` container (the `SCULPT00` BinFile
 * header documented in `sculptcore/source/litestl/io/binfile.h`).
 *
 * Zero imports — kept unit-testable in isolation, like frustum.ts.
 */

const MINMATCH = 4
const MFLIMIT = 12 // matches may not start within the last 12 bytes
const LASTLITERALS = 5 // the last 5 bytes are always literals
const MAX_DISTANCE = 65535
const HASH_LOG = 16
const HASH_SIZE = 1 << HASH_LOG

/** Worst-case compressed size for `n` input bytes (LZ4_compressBound). */
export function lz4CompressBound(n: number): number {
  return n + Math.floor(n / 255) + 16
}

function read32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
}

function hash32(seq: number): number {
  return (Math.imul(seq, 2654435761) >>> (32 - HASH_LOG)) & (HASH_SIZE - 1)
}

/**
 * Compress `src` into a single LZ4 block. Fast hash-chain match finder (one
 * candidate per position); skips re-seeding inside a match, trading a little
 * ratio for speed. The end-of-block invariants (no match in the last 12 bytes,
 * a trailing literal run) make the output safe for `LZ4_decompress_safe`.
 */
export function lz4Compress(src: Uint8Array): Uint8Array {
  const sLength = src.length
  const dst = new Uint8Array(lz4CompressBound(sLength))
  let d = 0

  // Too small to ever match: emit one all-literals sequence.
  if (sLength < MFLIMIT + 1) {
    return dst.subarray(0, emitLiterals(dst, 0, src, 0, sLength))
  }

  const hashTable = new Int32Array(HASH_SIZE).fill(-1)
  const mflimit = sLength - MFLIMIT
  const matchlimit = sLength - LASTLITERALS
  let anchor = 0
  let pos = 1 // the very first byte is never a match start

  while (pos < mflimit) {
    // Scan forward for a candidate match.
    let match = -1
    while (pos < mflimit) {
      const seq = read32(src, pos)
      const h = hash32(seq)
      const ref = hashTable[h]
      hashTable[h] = pos
      if (ref >= 0 && pos - ref <= MAX_DISTANCE && read32(src, ref) === seq) {
        match = ref
        break
      }
      pos++
    }
    if (match < 0) {
      break
    }

    // Extend the match (past the 4 guaranteed bytes) up to matchlimit.
    let mp = pos + MINMATCH
    let rp = match + MINMATCH
    while (mp < matchlimit && src[mp] === src[rp]) {
      mp++
      rp++
    }
    const matchLen = mp - pos
    const offset = pos - match

    // token + literal run + offset + match-length tail
    const litLen = pos - anchor
    const encMatch = matchLen - MINMATCH
    dst[d++] = (Math.min(litLen, 15) << 4) | Math.min(encMatch, 15)
    if (litLen >= 15) {
      d = writeLength(dst, d, litLen - 15)
    }
    for (let i = 0; i < litLen; i++) {
      dst[d++] = src[anchor + i]
    }
    dst[d++] = offset & 0xff
    dst[d++] = (offset >>> 8) & 0xff
    if (encMatch >= 15) {
      d = writeLength(dst, d, encMatch - 15)
    }

    pos = mp
    anchor = pos
  }

  // Trailing literals (always present; >= LASTLITERALS once any match emitted).
  return dst.subarray(0, emitLiterals(dst, d, src, anchor, sLength - anchor))
}

/** LZ4 length varint: 255-runs then the remainder. */
function writeLength(dst: Uint8Array, d: number, n: number): number {
  while (n >= 255) {
    dst[d++] = 255
    n -= 255
  }
  dst[d++] = n
  return d
}

/** Emit a final literals-only sequence (token with a zero match nibble). */
function emitLiterals(dst: Uint8Array, d: number, src: Uint8Array, from: number, len: number): number {
  dst[d++] = Math.min(len, 15) << 4
  if (len >= 15) {
    d = writeLength(dst, d, len - 15)
  }
  for (let i = 0; i < len; i++) {
    dst[d++] = src[from + i]
  }
  return d
}

/**
 * Decompress one LZ4 block into a buffer of the known `rawSize`. Trusts
 * `rawSize` (the size recorded in the container header); throws on a malformed
 * block rather than overrunning.
 */
export function lz4Decompress(src: Uint8Array, rawSize: number): Uint8Array {
  const dst = new Uint8Array(rawSize)
  const sEnd = src.length
  let s = 0
  let d = 0

  while (s < sEnd) {
    const token = src[s++]
    let litLen = token >>> 4
    if (litLen === 15) {
      let b: number
      do {
        b = src[s++]
        litLen += b
      } while (b === 255)
    }
    for (let i = 0; i < litLen; i++) {
      dst[d++] = src[s++]
    }
    if (s >= sEnd) {
      break // final literals: no match follows
    }
    const offset = src[s++] | (src[s++] << 8)
    let matchLen = token & 0x0f
    if (matchLen === 15) {
      let b: number
      do {
        b = src[s++]
        matchLen += b
      } while (b === 255)
    }
    matchLen += MINMATCH
    let m = d - offset
    if (m < 0) {
      throw new Error('lz4Decompress: bad offset')
    }
    for (let i = 0; i < matchLen; i++) {
      dst[d++] = dst[m++]
    }
  }

  if (d !== rawSize) {
    throw new Error(`lz4Decompress: produced ${d} bytes, expected ${rawSize}`)
  }
  return dst
}

// ---- sculptcore mesh-blob container (serial::writeMesh format) ----

const MAGIC = [0x53, 0x43, 0x55, 0x4c, 0x50, 0x54, 0x30, 0x30] // "SCULPT00"
const FLAG_LITTLE_ENDIAN = 1
const FLAG_COMPRESSED = 2
/** Header length before the lz4 payload: magic(8)+flags(1)+ver(3)+u32*3(12). */
const MESH_HEADER_LEN = 24

/** The mesh blob format version `serial::writeMesh` stamps. Must match C++
 * `serial::kMeshFormatVersion` (sculptcore/source/mesh/mesh_serialize.h); the
 * cross-language check in tests/unit/lz4.test.ts fails the build on drift. */
export const MESH_FORMAT_VERSION = 6

function writeU32LE(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff
  b[o + 1] = (v >>> 8) & 0xff
  b[o + 2] = (v >>> 16) & 0xff
  b[o + 3] = (v >>> 24) & 0xff
}

function readU32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

/**
 * Wrap an uncompressed mesh payload (from `Mesh_serializeRaw`) into the
 * lz4hc-compatible `SCULPT00` container `serial::writeMesh` produces, so it
 * round-trips through `Mesh_deserialize` / `serial::readMesh`. This is the
 * worker's job (the lz4 step is the expensive part split off the main thread).
 */
export function compressMeshBlob(raw: Uint8Array, meshFormatVersion = MESH_FORMAT_VERSION): Uint8Array {
  const comp = lz4Compress(raw)
  const out = new Uint8Array(MESH_HEADER_LEN + comp.length)
  out.set(MAGIC, 0)
  out[8] = FLAG_LITTLE_ENDIAN | FLAG_COMPRESSED
  out[9] = 0
  out[10] = 0
  out[11] = 1 // version{major,minor,micro} = {0,0,1}
  writeU32LE(out, 12, meshFormatVersion)
  writeU32LE(out, 16, raw.length)
  writeU32LE(out, 20, comp.length)
  out.set(comp, MESH_HEADER_LEN)
  return out
}

/** Header fields + the still-compressed lz4 payload of a `SCULPT00` blob. */
export interface MeshBlobParts {
  meshFormatVersion: number
  rawSize: number
  compBytes: Uint8Array
}

/** Parse a `SCULPT00` mesh blob into its header + compressed payload. */
export function splitMeshBlob(blob: Uint8Array): MeshBlobParts {
  for (let i = 0; i < 8; i++) {
    if (blob[i] !== MAGIC[i]) {
      throw new Error('splitMeshBlob: bad magic')
    }
  }
  const flags = blob[8]
  if (!(flags & FLAG_COMPRESSED)) {
    throw new Error('splitMeshBlob: blob is not compressed')
  }
  const meshFormatVersion = readU32LE(blob, 12)
  const rawSize = readU32LE(blob, 16)
  const compSize = readU32LE(blob, 20)
  return {
    meshFormatVersion,
    rawSize,
    compBytes: blob.subarray(MESH_HEADER_LEN, MESH_HEADER_LEN + compSize),
  }
}

/** Decompress a `SCULPT00` mesh blob back to its uncompressed payload bytes. */
export function decompressMeshBlob(blob: Uint8Array): Uint8Array {
  const {rawSize, compBytes} = splitMeshBlob(blob)
  return lz4Decompress(compBytes, rawSize)
}
