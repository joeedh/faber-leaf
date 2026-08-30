/**
 * Defines what `@framework/pathux` resolves to under jest — P19 §5 step 6.
 *
 * The real alias resolves to `scripts/path.ux/scripts/pathux.ts`, the toolkit's
 * whole barrel, covering widgets, screen areas, and DOM. Nothing the UV solver wants, and
 * importing it under jsdom drags in custom-element registration for no reason.
 * The three leaf modules below are what the barrel re-exports for the solver's
 * sake, so a suite can import them directly and stay engine-free.
 *
 * Keep the exported names identical to the barrel's. A rename here would let a
 * suite pass against a symbol the app does not actually have.
 */

export {Constraint, Solver} from '../../scripts/path.ux/scripts/path-controller/util/solver'
export {Matrix4, Vector2, Vector3, Vector4} from '../../scripts/path.ux/scripts/path-controller/util/vectormath'
export * as math from '../../scripts/path.ux/scripts/path-controller/util/math'
