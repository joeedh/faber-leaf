/**
 * Public API surface for the `litemesh` builtin addon — the peer-addon entry
 * point (`@addon/litemesh/api`). Keep in sync with `main.ts`'s
 * `exportNamespace('litemesh', …)`.
 */

export {LiteMesh, LiteMeshDisplayMode} from './index.js'
export {SculptCorePaintMode} from './sculptcore.js'
export {BoxModelToolMode} from './boxmodel.js'
export {PaintToolModeBase} from './stroke_base.js'
