// ObjectEditor and PanToolMode stay in core (always-present, not addons).
import './selecttool'
import './view3d_panmode'

// The remaining toolmodes are addons. Each module registers itself with
// ToolMode.register at import time; they are announced to AddonManager (so they
// show up in the addon system) by addons/builtin/sculptcore's register() hook,
// wired through addons/builtin/builtin_registry.ts.
import './sculptcore.js'
import './boxmodel.js'

// sculptcore_ops still needs to be imported for ToolOp side-effect registrations
// — those are addon-owned but the operator classes aren't currently routed
// through the addon system. Lands properly when sculptcore actually moves to
// out-of-bundle build.
import './sculptcore_ops'

export {ToolModes} from '../view3d_toolmode.js'
