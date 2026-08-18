/**
 * Layer boundary rules for the Faber Leaf refactor.
 *
 * Caught here (in addition to ESLint) because dependency-cruiser walks the actual
 * module graph including .js files and dynamic imports, so it catches cases the lint
 * rules might miss.
 *
 * P9 converted every rule that could be driven to zero to `severity: error`. The
 * three that remain at `warn` are ratcheted by per-rule budgets in
 * tools/layer-baseline.json and each carries a comment naming the plan that closes
 * it and the date it is expected to close. A `warn` rule here is a dated debt, never
 * a permanently softened gate.
 *
 * See documentation/plans/2026-08-15-0300-ci-and-layer-gate-repair.md and
 * documentation/plans/2026-08-15-0340-w1-layer-ratchet.md.
 */

// The narrow core: layers that must never reach addon or geometry-implementation
// code, transitively or otherwise.
const CORE = '^scripts/(core|util|scene|sceneobject)/'

// Everything host-side that addons are allowed to depend on but which must not
// depend back on an addon. Wider than CORE: editors, the tet/hair stacks and the
// whole renderer are host layers too, they were simply never measured.
const HOST = '^scripts/(core|util|scene|sceneobject|editors|tet|hair|render|renderengine|shadernodes|webgpu|shaders)/'

// Host files that are themselves BREP code: the tet/hair stacks and the BREP half
// of the transform stack. They import the mesh addon because they *are* mesh code
// that has not been moved yet, and P13 deletes them outright. Exempted by name from
// core-no-addons (so that rule can be `error`) and re-counted at their own budget by
// brep-consumers-no-addons, so the coupling stays ratcheted rather than invisible.
// Owner: P13 (BREP deletion). Expected to close when P13 lands; delete this const
// and the brep-consumers-no-addons rule with it.
const BREP_CONSUMERS = [
  '^scripts/(tet|hair)/',
  '^scripts/editors/view3d/transform/transform_(base|inset|ops|types)\\.ts$',
]

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name    : 'core-no-mesh',
      severity: 'error',
      comment:
        'scripts/core/ must not depend on the mesh addon. Use the data_kinds / default_file / ' +
        'file_migrations registries instead (strategy §3). Type-only edges are excluded here ' +
        'because core-no-addons-typeonly already counts them — excluded, not exempted.',
      from    : {path: '^scripts/core/'},
      to      : {path: '^addons/builtin/mesh/', dependencyTypesNot: ['type-only']},
    },
    {
      name    : 'core-no-view3d-tools',
      severity: 'error',
      comment:
        'scripts/core/ must not depend on individual view3d toolmodes. Only the ToolMode base ' +
        'in scripts/editors/view3d/view3d_toolmode is allowed.',
      from    : {path: '^scripts/core/'},
      to      : {path: '^scripts/editors/view3d/tools/'},
    },
    {
      name    : 'util-no-mesh',
      severity: 'error',
      comment : 'scripts/util/ must stay mesh-agnostic. Extract needed interfaces into util/spatial.ts.',
      from    : {path: '^scripts/util/'},
      to      : {path: '^addons/builtin/mesh/'},
    },
    {
      name    : 'core-no-addons',
      severity: 'error',
      comment:
        'Host layers must not import addon source. Addons depend on the host, never the reverse. ' +
        'Type-only imports are counted separately by core-no-addons-typeonly rather than ' +
        'exempted, and indirect reach is counted by core-no-addons-transitive. The BREP_CONSUMERS ' +
        'files are excluded from `from` and re-counted by brep-consumers-no-addons.',
      from    : {path: HOST, pathNot: BREP_CONSUMERS},
      to      : {path: '^addons/', dependencyTypesNot: ['type-only']},
    },
    {
      name    : 'brep-consumers-no-addons',
      severity: 'warn',
      comment:
        'The host-side BREP code excluded from core-no-addons, counted at its own budget so the ' +
        'coupling cannot grow while it waits to be deleted. Owner: P13 (BREP deletion), which ' +
        'removes scripts/tet, scripts/hair and the BREP transform stack and takes this rule with ' +
        'them. Expected to close with P13; this is the only reason it is not `error`.',
      from    : {path: BREP_CONSUMERS},
      to      : {path: '^addons/', dependencyTypesNot: ['type-only']},
    },
    {
      name    : 'core-no-addons-typeonly',
      severity: 'warn',
      comment:
        'Type-only imports from a host layer into an addon erase at compile time, so they create ' +
        'no runtime dependency — but they are still a structural coupling, and they are the set ' +
        'that has to move to a host-owned interface. Counted, not forbidden outright. ' +
        'Owner: P13 (BREP deletion) for the BREP transform stack, and the same for the two ' +
        'core/ hits (context.ts, lib_api.ts) whose types are BREP mesh types.',
      from    : {path: HOST},
      to      : {path: '^addons/', dependencyTypes: ['type-only']},
    },
    {
      name    : 'core-no-addons-transitive',
      severity: 'warn',
      comment:
        'Core must not *reach* addon source at all, not merely avoid importing it directly. ' +
        'This is what catches core/context.ts -> tet/tetgen.js -> addons/builtin/mesh/src/bvh.js. ' +
        'Kept separate from core-no-addons so the direct and indirect numbers stay legible. ' +
        'Owner: P13 (BREP deletion). Every surviving route runs through a BREP_CONSUMERS file, ' +
        'and a `reachable` restriction cannot exclude an intermediate: dependency-cruiser 17.4.0 ' +
        'types it as IReachabilityToRestrictionType, which admits only path/pathNot/reachable ' +
        '(`via`/`viaOnly` are circular-dependency modifiers). So this is the one rule P9 could ' +
        'not flip; it goes to `error` for free once P13 deletes the intermediates.',
      from    : {path: CORE},
      to      : {path: '^addons/', reachable: true},
    },
    {
      name    : 'core-no-litemesh',
      severity: 'error',
      comment:
        'Core must not depend on the LiteMesh implementation. Does not fire today and must not ' +
        'start: LiteMesh is a geometry type like any other (strategy §3).',
      from    : {path: CORE},
      to      : {path: '^scripts/lite-mesh/'},
    },
    {
      name    : 'core-no-sculptcore',
      severity: 'error',
      comment:
        'Core must not depend on the sculptcore engine — it has to stay optional (W3). Matches the ' +
        'resolved submodule path, not the @sculptcore/ alias: pnpm symlinks the workspace package, ' +
        'and dependency-cruiser matches rules against the resolved path.',
      from    : {path: CORE},
      to      : {path: ['^sculptcore/', '^node_modules/@sculptcore/']},
    },
    {
      name    : 'no-circular',
      severity: 'warn',
      comment:
        'Circular dependencies make refactoring impossible. Track and reduce over time. ' +
        'Owner: P17 (cycle cleanup); ratcheted by budget until then.',
      from    : {},
      to      : {circular: true},
    },
  ],

  options: {
    // Anchored: an unanchored 'sculptcore' also matched addons/builtin/sculptcore/
    // and scripts/editors/view3d/tools/sculptcore*.ts, silently truncating the graph.
    doNotFollow: {
      path: ['node_modules', '^sculptcore/', '^build/', '^dist/'],
    },
    exclude: {
      path: [
        'node_modules',
        '^scripts/path\\.ux/',
        '^scripts/mathl/',
        '^scripts/extern/',
        '^build/',
        '^dist/',
        '^esdocs/',
        '^docs/',
        '\\.test\\.(t|j)sx?$',
      ],
    },
    tsConfig   : {fileName: 'tsconfig.json'},

    // Without this, dependency-cruiser analyses the *post*-compilation graph and
    // `import type` edges do not exist at all — which is why the old config's
    // `dependencyTypesNot: ['type-only']` exemption was a no-op. We need them in
    // the graph so core-no-addons-typeonly can count them.
    tsPreCompilationDeps: true,

    enhancedResolveOptions: {
      exportsFields : ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields    : ['module', 'main', 'types', 'typings'],
      extensions    : ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },

    reporterOptions: {
      text: {highlightFocused: true},
    },
  },
}
