/**
 * The host's selection vocabulary.
 *
 * # Frozen wire format
 *
 * `SelMask`'s bits are **persisted** — in `Scene.selectMask`,
 * `ToolMode.storedSelectMask`, `BoxModelToolMode.boxModelSelMode`, and in
 * keymap strings such as `view3d.translate(selmask=17)`. Every bit below is
 * therefore reserved *forever* with the meaning given, whether or not any
 * geometry type currently uses it:
 *
 * ```
 *   1  VERTEX          1<<8   MESH
 *   2  EDGE            1<<9   LIGHT
 *   4  FACE            1<<10  (retired, never reused)
 *   8  LOOP  (reserved, never reused)
 *                      1<<11  CAMERA
 *  16  HANDLE          1<<12  NULLOBJECT
 *                      1<<13  PROCMESH
 *                      1<<14  TETMESH
 *                      1<<15  STRANDS
 *                      1<<16+ allocated by registerSelectType()
 * ```
 *
 * Bit 8 stays reserved even though no BREP remains to use it: `selmask=17` must
 * keep meaning `VERTEX | HANDLE`. Reserving a bit costs nothing; recovering from
 * having reused one costs a file-format migration.
 *
 * Bits 1–16 used to be *derived* from the mesh addon's `MeshTypes`, which made a
 * host file depend on an addon's element-type enum. They are literals here now;
 * the mesh addon asserts agreement at registration.
 *
 * # Persistence
 *
 * Masks are written to files as **names** (`selMaskToNames`), not integers, so
 * that a mask survives the set of registered geometry types changing between the
 * save and the load. Readers accept either — see `normalizeSelMask`.
 */

export const SelToolModes = {
  ADD : 0,
  SUB : 1,
  AUTO: 2,
}

export const SelOneToolModes = {
  ADD   : 0,
  SUB   : 1,
  UNIQUE: 2,
}

/*
 * Represents all the types of data
 * that are "selectable" via findnearest api.
 *
 * Note that each SceneObjectData implementation can
 * have multiple submodes, e.g. vertex selection vs edge/face
 * selection for meshes.
 *
 * The fields after GEOM is for picking whole objects with specific
 * SceneObjectData types.
 * */
export const SelMask: {[k: string]: number} = {
  VERTEX: 1,
  EDGE  : 2,
  FACE  : 4,
  //8 is the retired LOOP bit
  HANDLE: 16,
  GEOM  : 1 | 2 | 4,

  SGEOM: 1 | 2 | 4,

  //save some space for more per-SceneObjectData findnearest modes

  MESH      : 1 << 8,
  LIGHT     : 1 << 9,
  CAMERA    : 1 << 11,
  NULLOBJECT: 1 << 12,
  PROCMESH  : 1 << 13,
  TETMESH   : 1 << 14,
  STRANDS   : 1 << 15,
  // Derived — the OR of every registered object bit. Kept up to date by
  // registerSelectType(); 1<<10 is a retired type with no name, and stays in
  // the union so old files keep round-tripping.
  OBJECT    : 0,
}

/** The geometry-half bits, which are frozen literals and never registry-allocated. */
export const GEOM_SEL_BITS = SelMask.VERTEX | SelMask.EDGE | SelMask.FACE | 8 | SelMask.HANDLE

/** Object bits present in files but with no name of their own. */
const RETIRED_OBJECT_BITS = 1 << 10

/** Object-half names in bit order, in their frozen positions. */
const BUILTIN_OBJECT_TYPES = ['MESH', 'LIGHT', 'CAMERA', 'NULLOBJECT', 'PROCMESH', 'TETMESH', 'STRANDS']

const objectBits = new Map<string, number>()

/** Highest bit index an allocation may use — JS bitwise ops are 32-bit signed. */
const MAX_SEL_BIT = 30

let nextObjectBit = 1 << 16

function recomputeObject(): void {
  let mask = RETIRED_OBJECT_BITS
  for (const bit of objectBits.values()) mask |= bit
  SelMask.OBJECT = mask
}

/**
 * Claim a `SelMask` bit for a `SceneObjectData` type. Idempotent — re-registering
 * a name returns the bit it already has, so an addon that is disabled and
 * re-enabled keeps its bit for the lifetime of the process.
 *
 * The returned value is in-memory only: masks persist as names, so allocation
 * order never reaches a file.
 */
export function registerSelectType(name: string): number {
  const existing = objectBits.get(name)
  if (existing !== undefined) return existing

  if (nextObjectBit > 1 << MAX_SEL_BIT) {
    throw new Error(`select-type registry is full; cannot allocate a bit for "${name}"`)
  }

  const bit = nextObjectBit
  nextObjectBit <<= 1

  objectBits.set(name, bit)
  SelMask[name] = bit
  recomputeObject()

  return bit
}

/** Test-only: drop registry-allocated types, restoring the builtin object half. */
export function _resetSelectTypesForTests(): void {
  for (const [name, bit] of objectBits) {
    if (!BUILTIN_OBJECT_TYPES.includes(name)) {
      delete SelMask[name]
      objectBits.delete(name)
      void bit
    }
  }
  nextObjectBit = 1 << 16
  recomputeObject()
}

for (const name of BUILTIN_OBJECT_TYPES) objectBits.set(name, SelMask[name])
recomputeObject()

/** Every name a mask may decompose into, longest-bit-first for stable output. */
function namedBits(): [string, number][] {
  const out: [string, number][] = []
  for (const [name, value] of Object.entries(SelMask)) {
    // GEOM/SGEOM/OBJECT are unions, not bits; they would swallow their members.
    if (name === 'GEOM' || name === 'SGEOM' || name === 'OBJECT') continue
    if (value && (value & (value - 1)) === 0) out.push([name, value])
  }
  out.sort((a, b) => a[1] - b[1])
  return out
}

/**
 * Encode a mask as a `|`-joined name list for persistence. A bit with no name
 * (the retired `1<<10`, or a type whose addon is not loaded) is emitted as
 * `unknown:<bitIndex>` so it survives a load/save round-trip instead of being
 * silently dropped.
 */
export function selMaskToNames(mask: number): string {
  const parts: string[] = []
  let rest = mask >>> 0

  for (const [name, bit] of namedBits()) {
    if (rest & bit) {
      parts.push(name)
      rest &= ~bit
    }
  }

  for (let i = 0; i <= MAX_SEL_BIT + 1 && rest; i++) {
    const bit = (1 << i) >>> 0
    if (rest & bit) {
      parts.push(`unknown:${i}`)
      rest &= ~bit
    }
  }

  return parts.join('|')
}

/** Inverse of `selMaskToNames`. Unrecognized names are ignored, not fatal. */
export function selMaskFromNames(names: string): number {
  let mask = 0

  for (const raw of names.split('|')) {
    const part = raw.trim()
    if (!part) continue

    if (part.startsWith('unknown:')) {
      const i = parseInt(part.slice('unknown:'.length), 10)
      if (Number.isFinite(i) && i >= 0 && i <= MAX_SEL_BIT + 1) mask |= 1 << i
      continue
    }

    const bit = SelMask[part]
    if (bit !== undefined) {
      mask |= bit
    } else {
      console.warn(`select_types: unknown selection mode "${part}"`)
    }
  }

  return mask
}

/**
 * Read a persisted mask that may be either form: a name list (current) or a raw
 * integer (any file written before the format changed, and any third-party
 * keymap string). Anything else yields `fallback`.
 */
export function normalizeSelMask(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value | 0
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s) return fallback
    // A bare integer is the legacy on-disk form and the keymap form.
    if (/^-?\d+$/.test(s)) return parseInt(s, 10) | 0
    return selMaskFromNames(s)
  }
  return fallback
}
