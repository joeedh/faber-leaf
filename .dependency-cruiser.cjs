/**
 * Layer boundary rules for the Faber Leaf refactor.
 *
 * Caught here (in addition to ESLint) because dependency-cruiser walks the actual
 * module graph including .js files and dynamic imports, so it catches cases the lint
 * rules might miss.
 *
 * P9 converted every rule that could be driven to zero to `severity: error` and
 * left three at `warn` behind dated budgets. P13 deleted the BREP, which was the
 * only thing holding those three open, so every layer rule here is now `error`
 * and reads 0. The one remaining `warn` is no-circular, which is P17's.
 *
 * A `warn` rule here is a dated debt, never a permanently softened gate: it must
 * name the plan that closes it and be ratcheted by a per-rule budget in
 * tools/layer-baseline.json.
 *
 * See documentation/plans/2026-08-15-0300-ci-and-layer-gate-repair.md,
 * documentation/plans/2026-08-15-0340-w1-layer-ratchet.md and
 * documentation/plans/2026-08-15-0400-w1-delete-ts-brep.md.
 */

// The narrow core: layers that must never reach addon or geometry-implementation
// code, transitively or otherwise.
const CORE = '^scripts/(core|util|scene|sceneobject)/'

// Everything host-side that addons are allowed to depend on but which must not
// depend back on an addon. Wider than CORE: the editors and the whole renderer are
// host layers too, they were simply never measured. (P13 deleted scripts/tet and
// scripts/hair, which used to be listed here.)
const HOST = '^scripts/(core|util|scene|sceneobject|editors|render|renderengine|shadernodes|webgpu|shaders)/'

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
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
      name    : 'core-no-addons',
      severity: 'error',
      comment:
        'Host layers must not import addon source. Addons depend on the host, never the reverse. ' +
        'Type-only imports are counted separately by core-no-addons-typeonly rather than ' +
        'exempted, and indirect reach is counted by core-no-addons-transitive. All three are ' +
        '`error` and read 0; there is no exempted set any more (P13 deleted it).',
      from    : {path: HOST},
      to      : {path: '^addons/', dependencyTypesNot: ['type-only']},
    },
    {
      name    : 'core-no-addons-typeonly',
      severity: 'error',
      comment:
        'Type-only imports from a host layer into an addon erase at compile time, so they create ' +
        'no runtime dependency — but they are still a structural coupling. P13 drove the last ' +
        'seven to zero, so this is `error` now: a host file that needs an addon type declares a ' +
        'host-owned interface for the shape it actually uses (camera.ts CameraPathCurve is the ' +
        'worked example) rather than importing the class.',
      from    : {path: HOST},
      to      : {path: '^addons/', dependencyTypes: ['type-only']},
    },
    {
      name    : 'core-no-addons-transitive',
      severity: 'error',
      comment:
        'Core must not *reach* addon source at all, not merely avoid importing it directly. ' +
        'It used to catch core/context.ts reaching a BREP BVH through the tet generator. ' +
        'Kept separate from core-no-addons so the direct and indirect numbers stay legible. ' +
        'P9 could not flip it: every surviving route ran through an intermediate it had to ' +
        'exempt, and a `reachable` restriction cannot exclude one (dependency-cruiser 17.4.0 ' +
        'types it as IReachabilityToRestrictionType, which admits only path/pathNot/reachable; ' +
        '`via`/`viaOnly` are circular-dependency modifiers). P13 deleted the intermediates, ' +
        'which took all 800 edges with them.',
      from    : {path: CORE},
      to      : {path: '^addons/', reachable: true},
    },
    {
      name    : 'core-no-litemesh',
      severity: 'error',
      comment:
        'Core must not depend on the LiteMesh implementation. Does not fire today and must not ' +
        'start: LiteMesh is a geometry type like any other (strategy §3). P15 moved it into an ' +
        'addon, so this is now a named specialization of core-no-addons — kept separate because ' +
        'a LiteMesh edge is the one this project keeps regrowing.',
      from    : {path: CORE},
      to      : {path: '^addons/builtin/litemesh/'},
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
    // Anchored: an unanchored 'sculptcore' also matched the addon's own
    // sculptcore*.ts modules, silently truncating the graph.
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
