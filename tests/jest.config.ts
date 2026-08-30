/**
 * Jest config for the Faber Leaf test workspace.
 *
 * - jsdom environment because most framework code touches window / document / _appstate
 * - @swc/jest transforms .ts and .js (faster than ts-jest, no separate tsconfig wiring)
 * - moduleNameMapper rewrites the framework's .js suffix to allow Jest's resolver to
 *   find the actual .ts source (the build is bundled by esbuild in production)
 *
 * Tests live under tests/{unit,integration,build}/**.test.ts. tests/lib/ holds shared
 * helpers (jest-setup, png_gray) and is excluded from collection. Save/load
 * round-trips are NOT built here: this environment cannot import the real
 * serialization modules, so they live in the NW.js `tests/integration`
 * workspace instead (P10 §5, §5a correction 3).
 */

import type {Config} from 'jest'

const config: Config = {
  clearMocks      : true,
  coverageProvider: 'v8',
  rootDir         : '.',
  testEnvironment : 'jsdom',

  moduleFileExtensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'],

  // The integration suites each boot a real NW.js app; letting jest scale
  // workers to the core count spawns far too many at once.
  // TODO: 5, not 6, is a temporary global job cap for the Faber Leaf refactor
  // (see that strategy doc's §9.3 note). Restore 6 when the refactor lands.
  maxWorkers: 6,

  testMatch: ['<rootDir>/**/*.test.ts', '<rootDir>/**/*.test.tsx'],

  // Don't try to load helpers as tests. integration/ is its own workspace
  // package (@faber-leaf/tests-integration) that runs its suites once
  // per sculptcore backend — see integration/run-split.mjs.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/lib/', '<rootDir>/fixtures/', '<rootDir>/integration/'],

  // Per-file setup: polyfills jsdom-missing browser globals (URL.createObjectURL etc.)
  setupFiles: ['<rootDir>/lib/jest-setup.ts'],

  // fake-indexeddb leaves a few internal timers running on test teardown,
  // so jest never voluntarily exits. forceExit terminates the worker after
  // all tests resolve.
  forceExit: true,

  transform: {
    // .mjs included so tests can drive the repo's ESM tooling scripts (tools/*.mjs)
    // directly; without it jest loads them as CJS and chokes on `export`.
    '^.+\\.[mc]?[tj]sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: {
            syntax    : 'typescript',
            tsx       : true,
            decorators: true,
          },
          target   : 'es2022',
          transform: {
            decoratorMetadata: true,
            // Stage-3 decorators + auto-accessors (`accessor x = ...`) which
            // pathux's widgets use. Without this, importing any module that
            // transitively pulls in path.ux/scripts/widgets fails to parse.
            decoratorVersion : '2022-03',
          },
        },
        module: {
          type: 'es6',
        },
      },
    ],
  },

  // Framework imports use a .js suffix even on .ts sources (e.g.
  // import {...} from '../path.ux/scripts/pathux.js'). Strip the .js so Jest's
  // resolver finds the .ts.
  //
  // @framework/pathux is an esbuild alias for the toolkit barrel, which jest
  // cannot resolve and would not want to: see lib/pathux_shim.ts.
  moduleNameMapper: {
    '^@framework/pathux$' : '<rootDir>/lib/pathux_shim.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  extensionsToTreatAsEsm: ['.ts', '.tsx', '.mts'],
}

export default config
