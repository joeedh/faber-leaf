/**
 * Dependency-free stroke geometry math for the brush stroke driver
 * (`addons/builtin/litemesh/src/stroke_driver.ts`).
 *
 * Everything here operates on plain `number[]` points (2D for screen space, 3D
 * for world space) and imports nothing from path.ux / vectormath, so it loads in
 * the jsdom unit harness (see tests/unit/stroke_math.test.ts). The driver layers
 * raycasting, projection and PaintSample construction on top.
 */

export type Vec = number[]

const EPS = 1e-7

function sub(a: Vec, b: Vec): Vec {
  const out: Vec = new Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i]
  return out
}
function addScaled(a: Vec, b: Vec, fac: number): Vec {
  const out: Vec = new Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i] * fac
  return out
}

export function dist(a: Vec, b: Vec): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

export function lerpV(a: Vec, b: Vec, t: number): Vec {
  const out: Vec = new Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t
  return out
}

/** A cubic Bezier as its four control points. */
export type Cubic = [Vec, Vec, Vec, Vec]

/**
 * Catmull-Rom segment between P1 and P2 → cubic Bezier control points.
 *
 * `alpha` selects the knot parameterization: 0 = uniform, 0.5 = centripetal
 * (no cusps/self-intersections on clustered input), 1 = chordal. Endpoint
 * tangents become one-sided when a neighbor coincides with its endpoint, which
 * is how callers clamp the ends (pass P0===P1 or P3===P2).
 */
export function crToBezier(P0: Vec, P1: Vec, P2: Vec, P3: Vec, alpha = 0.5): Cubic {
  const t01 = Math.pow(dist(P0, P1), alpha)
  const t12 = Math.pow(dist(P1, P2), alpha)
  const t23 = Math.pow(dist(P2, P3), alpha)

  const span = t12 > EPS ? t12 : EPS

  // tangent at P1 (one-sided when the left neighbor is clamped)
  let m1: Vec
  if (t01 < EPS) {
    m1 = sub(P2, P1)
    for (let i = 0; i < m1.length; i++) m1[i] /= span
  } else {
    m1 = new Array(P1.length)
    for (let i = 0; i < P1.length; i++) {
      m1[i] = (P2[i] - P1[i]) / t12 - (P2[i] - P0[i]) / (t01 + t12) + (P1[i] - P0[i]) / t01
    }
  }

  // tangent at P2 (one-sided when the right neighbor is clamped)
  let m2: Vec
  if (t23 < EPS) {
    m2 = sub(P2, P1)
    for (let i = 0; i < m2.length; i++) m2[i] /= span
  } else {
    m2 = new Array(P2.length)
    for (let i = 0; i < P2.length; i++) {
      m2[i] = (P3[i] - P2[i]) / t23 - (P3[i] - P1[i]) / (t12 + t23) + (P2[i] - P1[i]) / t12
    }
  }

  const B0 = P1.slice()
  const B3 = P2.slice()
  const B1 = addScaled(P1, m1, span / 3)
  const B2 = addScaled(P2, m2, -span / 3)
  return [B0, B1, B2, B3]
}

export function evalCubic(B: Cubic, s: number): Vec {
  const mt = 1 - s
  const a = mt * mt * mt
  const b = 3 * mt * mt * s
  const c = 3 * mt * s * s
  const d = s * s * s
  const n = B[0].length
  const out: Vec = new Array(n)
  for (let i = 0; i < n; i++) out[i] = a * B[0][i] + b * B[1][i] + c * B[2][i] + d * B[3][i]
  return out
}

export function cubicDeriv(B: Cubic, s: number): Vec {
  const mt = 1 - s
  const a = 3 * mt * mt
  const b = 6 * mt * s
  const c = 3 * s * s
  const n = B[0].length
  const out: Vec = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = a * (B[1][i] - B[0][i]) + b * (B[2][i] - B[1][i]) + c * (B[3][i] - B[2][i])
  }
  return out
}

/** Split a cubic at `t` into its left ([0,t]) and right ([t,1]) sub-cubics. */
function deCasteljau(B: Cubic, t: number): {left: Cubic; right: Cubic} {
  const a = lerpV(B[0], B[1], t)
  const b = lerpV(B[1], B[2], t)
  const c = lerpV(B[2], B[3], t)
  const d = lerpV(a, b, t)
  const e = lerpV(b, c, t)
  const f = lerpV(d, e, t)
  return {left: [B[0].slice(), a, d, f], right: [f, e, c, B[3].slice()]}
}

/** Extract the sub-cubic over [t0, t1] ⊆ [0,1] as its own cubic Bezier. */
export function subCubic(B: Cubic, t0: number, t1: number): Cubic {
  t0 = Math.min(Math.max(t0, 0), 1)
  t1 = Math.min(Math.max(t1, 0), 1)
  if (t1 <= EPS) {
    const p = B[0].slice()
    return [p.slice(), p.slice(), p.slice(), p.slice()]
  }
  const head = deCasteljau(B, t1).left // [0, t1]
  return deCasteljau(head, t0 / t1).right // [t0, t1]
}

export interface WalkResult {
  /** parameter values in [0,1] at each evenly-spaced (by arc length) sample */
  ts: number[]
  /** leftover arc length to carry into the next segment's walk */
  carryOut: number
}

/**
 * Walk a cubic by arc length, emitting a parameter every `spacingDist` units.
 * `carryIn` is the leftover distance from the previous segment so the cadence is
 * continuous across abutting segments. Arc length is approximated by `fine`
 * straight chords; within a chord the parameter is interpolated linearly.
 */
export function arcLengthWalk(B: Cubic, spacingDist: number, carryIn = 0, fine = 32): WalkResult {
  const ts: number[] = []
  if (spacingDist <= EPS) return {ts, carryOut: carryIn}

  let acc = carryIn
  let prev = evalCubic(B, 0)

  for (let k = 1; k <= fine; k++) {
    const sA = (k - 1) / fine
    const sB = k / fine
    const cur = evalCubic(B, sB)
    const seg = dist(prev, cur)
    prev = cur

    if (seg <= EPS) continue

    let local = 0 // fraction of this chord already consumed
    while (acc + seg * (1 - local) >= spacingDist) {
      const need = spacingDist - acc
      local += need / seg
      ts.push(sA + (sB - sA) * local)
      acc = 0
    }
    acc += seg * (1 - local)
  }

  return {ts, carryOut: acc}
}
