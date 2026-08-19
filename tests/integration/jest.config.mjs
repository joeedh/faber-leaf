/**
 * Jest config for the `@faber-leaf/tests-integration` package.
 *
 * `rootDir` is the parent `tests/` directory so module resolution, the setup
 * file and the transform behave exactly as they do for the unit suites (this
 * package has no node_modules of its own — jest, @swc/jest and
 * jest-environment-jsdom all resolve from `tests/`). `testMatch` then narrows
 * the run to `integration/`.
 *
 * Mirrors `../jest.config.ts`; keep the transform + moduleNameMapper in sync.
 * The suites here are launched twice by `run-split.mjs` (wasm pass, native
 * pass) — see `./split.ts` for how a suite picks its pass.
 *
 * The handful of wall-clock-dominating suites in `./slow.mjs` are excluded by
 * default and selected exclusively when SC_TEST_SLOW=1 (`pnpm test:slow`).
 */

import {SLOW_GLOBS, SLOW_IGNORE, isSlowRun} from './slow.mjs'

const slow = isSlowRun()

/** @type {import('jest').Config} */
const config = {
  clearMocks      : true,
  coverageProvider: 'v8',
  rootDir         : '..',
  testEnvironment : 'jsdom',

  moduleFileExtensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'],

  // Every suite here boots a real NW.js app, so this is a count of concurrent
  // Chromium+WASM processes, not of cheap workers. Measured 2026-08-19: at 5,
  // seven suites died on `spawnSync nw.exe ETIMEDOUT`; at 2, all 22 pass.
  // TODO: unlike the unit config's, this 2 is not the Faber Leaf global job cap
  // (strategy §9.3) — it is the real ceiling for NW.js suites. Raise it only
  // with a measurement, not when the cap is reverted.
  maxWorkers: 2,

  testMatch: slow ? SLOW_GLOBS : ['<rootDir>/integration/**/*.test.ts'],

  testPathIgnorePatterns: slow
    ? ['/node_modules/', '<rootDir>/lib/', '<rootDir>/fixtures/']
    : ['/node_modules/', '<rootDir>/lib/', '<rootDir>/fixtures/', ...SLOW_IGNORE],

  // Polyfills jsdom-missing browser globals (URL.createObjectURL etc.)
  setupFiles: ['<rootDir>/lib/jest-setup.ts'],

  // fake-indexeddb leaves internal timers running past teardown, so jest never
  // voluntarily exits; forceExit terminates the worker once tests resolve.
  forceExit: true,

  transform: {
    '^.+\\.(t|j)sx?$': [
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
            decoratorVersion : '2022-03',
          },
        },
        module: {
          type: 'es6',
        },
      },
    ],
  },

  // Framework imports carry a .js suffix even on .ts sources; strip it so
  // Jest's resolver finds the .ts.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  extensionsToTreatAsEsm: ['.ts', '.tsx', '.mts'],
}

export default config
