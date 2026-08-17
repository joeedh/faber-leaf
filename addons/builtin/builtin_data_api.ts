// Inversion bridge: registers the builtin-addon classes that feed the core data
// API into the dependency-free registry leaf, so core `api_define.ts` never
// imports `addons/builtin/*`.
//
// `getDataAPI()` runs in the AppState constructor before any addon `register(api)`
// hook, and `tools/gen-datapaths.mjs` doesn't boot addons at all — so these can't
// wait for the per-addon lifecycle. The side-effect import (from entry_point.js and
// the gen-datapaths shim) populates the registry at module load; `registerDataAPI`
// is idempotent. External addons instead register via `addon_base.ts`'s dispatcher.
import {
  registerContextStruct,
  registerDataAPI,
  registerDataAPIBuilder,
} from '../../scripts/data_api/api_define_registry.js'

import {Mesh} from './mesh/src/mesh.js'
import {Vertex, Element} from './mesh/src/mesh_types.js'
import {BVHSettings} from './mesh/src/bvh.js'
import {buildCDAPI} from './mesh/src/customdata.js'
import {buildProcMeshAPI} from './mesh/src/mesh_gen.js'
import {CurveSpline} from './curve/src/curve.js'

registerDataAPI(BVHSettings)
registerDataAPI(Element)
registerDataAPI(Vertex)
registerDataAPI(Mesh)
registerDataAPI(CurveSpline)

// The mesh subsystem's two non-class builders. `buildCDAPI` is `before-classes`
// because `Mesh.defineAPI` attaches the CustomData element structs by
// reference; `buildProcMeshAPI` chains `DataBlock.defineAPI` and so must follow
// the class pass.
registerDataAPIBuilder({id: 'mesh.customdata', phase: 'before-classes', build: buildCDAPI})
registerDataAPIBuilder({id: 'mesh.procmesh', phase: 'after-classes', build: buildProcMeshAPI})

// `ctx.mesh`. Attaching by class reference rather than by nstructjs name is what
// turns an absent mesh addon from a boot throw into an absent subtree.
registerContextStruct({path: 'mesh', uiName: 'Mesh', cls: Mesh})
