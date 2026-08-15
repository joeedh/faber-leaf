/**
 * Layer boundary rules for the Faber Leaf refactor.
 *
 * Caught here (in addition to ESLint) because dependency-cruiser walks the actual
 * module graph including .js files and dynamic imports, so it catches cases the lint
 * rules might miss.
 *
 * Severity is `warn` while the refactor is in flight (the codebase has known
 * violations the migration will sever step-by-step). The ratchet that keeps the
 * count monotone until then lives in tools/check-layers.js (`--max-warnings`);
 * P9 is what converts these to `error`.
 *
 * See documentation/plans/2026-08-15-0300-ci-and-layer-gate-repair.md.
 */

// The narrow core: layers that must never reach addon or geometry-implementation
// code, transitively or otherwise.
const CORE = '^scripts/(core|util|scene|sceneobject)/'

// Everything host-side that addons are allowed to depend on but which must not
// depend back on an addon. Wider than CORE: editors, the tet/hair stacks and the
// whole renderer are host layers too, they were simply never measured.
const HOST = '^scripts/(core|util|scene|sceneobject|editors|tet|hair|render|renderengine|shadernodes|webgpu|shaders)/'

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name    : 'core-no-mesh',
      severity: 'warn',
      comment:
        'scripts/core/ must not depend on the mesh addon. Use the data_kinds / default_file / ' +
        'file_migrations registries instead (strategy §3).',
      from    : {path: '^scripts/core/'},
      to      : {path: '^addons/builtin/mesh/'},
    },
    {
      name    : 'core-no-view3d-tools',
      severity: 'warn',
      comment:
        'scripts/core/ must not depend on individual view3d toolmodes. Only the ToolMode base ' +
        'in scripts/editors/view3d/view3d_toolmode is allowed.',
      from    : {path: '^scripts/core/'},
      to      : {path: '^scripts/editors/view3d/tools/'},
    },
    {
      name    : 'util-no-mesh',
      severity: 'warn',
      comment : 'scripts/util/ must stay mesh-agnostic. Extract needed interfaces into util/spatial.ts.',
      from    : {path: '^scripts/util/'},
      to      : {path: '^addons/builtin/mesh/'},
    },
    {
      name    : 'core-no-addons',
      severity: 'warn',
      comment:
        'Host layers must not import addon source. Addons depend on the host, never the reverse. ' +
        'Type-only imports are counted separately by core-no-addons-typeonly rather than ' +
        'exempted, and indirect reach is counted by core-no-addons-transitive.',
      from    : {path: HOST},
      to      : {path: '^addons/', dependencyTypesNot: ['type-only']},
    },
    {
      name    : 'core-no-addons-typeonly',
      severity: 'warn',
      comment:
        'Type-only imports from a host layer into an addon erase at compile time, so they create ' +
        'no runtime dependency — but they are still a structural coupling, and they are the set ' +
        'that has to move to a host-owned interface. Counted, not forbidden outright.',
      from    : {path: HOST},
      to      : {path: '^addons/', dependencyTypes: ['type-only']},
    },
    {
      name    : 'core-no-addons-transitive',
      severity: 'warn',
      comment:
        'Core must not *reach* addon source at all, not merely avoid importing it directly. ' +
        'This is what catches core/context.ts -> tet/tetgen.js -> addons/builtin/mesh/src/bvh.js. ' +
        'Kept separate from core-no-addons so the direct and indirect numbers stay legible.',
      from    : {path: CORE},
      to      : {path: '^addons/', reachable: true},
    },
    {
      name    : 'core-no-litemesh',
      severity: 'warn',
      comment:
        'Core must not depend on the LiteMesh implementation. Does not fire today and must not ' +
        'start: LiteMesh is a geometry type like any other (strategy §3).',
      from    : {path: CORE},
      to      : {path: '^scripts/lite-mesh/'},
    },
    {
      name    : 'core-no-sculptcore',
      severity: 'warn',
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
      comment : 'Circular dependencies make refactoring impossible. Track and reduce over time.',
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
