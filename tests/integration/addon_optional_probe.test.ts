/**
 * P14 §6 acceptance: optional addon dependencies and force-disable, proved on
 * throwaway fixture addons rather than on LiteMesh.
 *
 * Three fixtures under tests/fixtures/addons (built by
 * `tools/build-addons.js --include-fixtures`, discovered through
 * build/addons/index.json):
 *
 *   optional_probe_dep     exports a `greet()` namespace;
 *   optional_probe         optionally depends on it, and records what it saw on
 *                          `globalThis.__optionalProbe` either way;
 *   optional_probe_broken  *requires* an addon that does not exist, and sets
 *                          `globalThis.__optionalProbeBrokenRan` if it ever runs.
 *
 * The manager is not unit-testable (addon_base.ts pulls path.ux + the shader
 * stack at module load — see tests/unit/addon_registries.test.ts), so each case
 * is a real headless NW.js boot; a `--eval` expression reports the manager state
 * back through `globalThis.__evalTestResult` → the `--dump` JSON's `evalResult`
 * (scripts/core/test_harness.ts).
 *
 * §6's five cases, and where each is covered:
 *
 *   both present                     → boot 1 (order + degraded path not taken)
 *   dependency force-disabled        → boot 2
 *   probe force-disabled             → boot 3
 *   required dependency absent       → boot 1 (optional_probe_broken)
 *   a cycle still throws             → tests/unit/addon_manifest.test.ts
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app
 * bundle (`build/entry_point.js`, `pnpm build`).
 */

import {execFileSync, execSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {isolatedProfileArgs, REPO_ROOT, resolveNwjsExe} from './nwjs_boot'
import {isDefaultBackendPass} from './split'

const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const INDEX_PATH = Path.join(REPO_ROOT, 'build', 'addons', 'index.json')

/** What the in-app `--eval` expression sends back through the dump. */
interface ProbeReport {
  registered: boolean
  hasDep: boolean
  greeting: string
}
interface ManagerState {
  /** Load (record) order — topological, so a dependency precedes its dependent. */
  order: string[]
  enabled: string[]
  unloaded: {id: string; reason: string; message: string}[]
  probe: ProbeReport | null
  brokenRan: boolean
}
interface Dump {
  evalResult?: ManagerState
}

// One expression, one token (see runBoot). Reads the manager straight off the
// window global that scripts/addon/addon.ts installs.
const REPORT_EXPR =
  'globalThis.__evalTestResult = (() => {' +
  ' const m = window._addons;' +
  ' return {' +
  ' order: [...m.idmap.keys()],' +
  ' enabled: [...m.idmap.entries()].filter(([, r]) => r.enabled).map(([id]) => id),' +
  ' unloaded: [...m.unloaded.values()].map((u) => ({id: u.id, reason: u.reason, message: u.message})),' +
  ' probe: globalThis.__optionalProbe || null,' +
  ' brokenRan: !!globalThis.__optionalProbeBrokenRan' +
  ' };' +
  '})()'

/** Boot the app headlessly with `--disable-addon` for each id, and report back. */
function runBoot(nwExe: string, forceDisabled: string[]): ManagerState {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'optprobe-')), 'dump.json')

  // `--eval=<expr>` / `--disable-addon=<id>` as single tokens: a bare value
  // token is parsed by headless Chromium as a positional URL and can abort the
  // launch. The `=` form is an ignored switch to Chromium; getArgList() reads
  // both (scripts/core/app_argv.ts).
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      'wasm',
      '--gen-scene',
      'empty',
      ...forceDisabled.map((id) => `--disable-addon=${id}`),
      `--eval=${REPORT_EXPR}`,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env: {...process.env}, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )

  if (!fs.existsSync(out)) throw new Error(`dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as Dump
  if (!dump.evalResult) throw new Error('harness dump carried no evalResult (did the --eval throw?)')
  return dump.evalResult
}

function unloadedReason(state: ManagerState, id: string): string | undefined {
  return state.unloaded.find((u) => u.id === id)?.reason
}

function fixturesInIndex(): boolean {
  try {
    const json = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8')) as {manifest: {id: string}}[]
    const ids = new Set(json.map((e) => e.manifest.id))
    return ['optional_probe', 'optional_probe_dep', 'optional_probe_broken'].every((id) => ids.has(id))
  } catch {
    return false
  }
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
// Backend-agnostic (the fixtures are pure JS): runs once, in the wasm pass.
const canRun = !!nwExe && haveBundle && isDefaultBackendPass()

if (!canRun && isDefaultBackendPass()) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[addon-optional-probe] skipped: ${why}`)
}

const maybe = canRun ? describe : describe.skip

maybe('optional addon dependencies + force-disable (headless)', () => {
  let both: ManagerState
  let noDep: ManagerState
  let noProbe: ManagerState

  beforeAll(() => {
    // A plain `pnpm build` rewrites index.json without the fixtures while
    // leaving their bundles on disk, so guard on the index, not the bundles.
    if (!fixturesInIndex()) {
      execSync('node tools/build-addons.js --include-fixtures', {cwd: REPO_ROOT, stdio: 'pipe'})
    }

    both = runBoot(nwExe!, [])
    noDep = runBoot(nwExe!, ['optional_probe_dep'])
    noProbe = runBoot(nwExe!, ['optional_probe'])
  }, 420000)

  describe('both present', () => {
    test('the optional dependency is loaded before its dependent', () => {
      expect(both.order).toContain('optional_probe_dep')
      expect(both.order).toContain('optional_probe')
      expect(both.order.indexOf('optional_probe_dep')).toBeLessThan(both.order.indexOf('optional_probe'))
    })

    test('both are enabled and the probe took its non-degraded path', () => {
      expect(both.enabled).toEqual(expect.arrayContaining(['optional_probe', 'optional_probe_dep']))
      expect(both.probe).toEqual({registered: true, hasDep: true, greeting: 'dep greets probe'})
    })
  })

  describe('a required dependency that does not exist', () => {
    test('disables the addon with a reason instead of throwing', () => {
      // The app booted at all (we have a dump), and only the broken addon paid.
      expect(unloadedReason(both, 'optional_probe_broken')).toBe('missing-dep')
      expect(both.order).not.toContain('optional_probe_broken')
      expect(both.brokenRan).toBe(false)
    })

    test('the recorded message names the missing dependency', () => {
      const entry = both.unloaded.find((u) => u.id === 'optional_probe_broken')
      expect(entry?.message).toContain('optional_probe_absent')
    })
  })

  describe('the optional dependency force-disabled', () => {
    test('it is never loaded, and is recorded as force-disabled', () => {
      expect(noDep.order).not.toContain('optional_probe_dep')
      expect(unloadedReason(noDep, 'optional_probe_dep')).toBe('force-disabled')
    })

    test('the dependent still loads and runs its degraded path', () => {
      expect(noDep.order).toContain('optional_probe')
      expect(noDep.probe?.registered).toBe(true)
      expect(noDep.probe?.hasDep).toBe(false)
      expect(noDep.probe?.greeting).toBe('degraded: optional_probe_dep is absent')
    })
  })

  describe('the dependent force-disabled', () => {
    test('the app boots and nothing else notices', () => {
      expect(noProbe.order).not.toContain('optional_probe')
      expect(unloadedReason(noProbe, 'optional_probe')).toBe('force-disabled')
      expect(noProbe.probe).toBeNull()
      // Disabling the dependent does not affect its dependency: the dependency still loads exactly as before.
      expect(noProbe.order).toContain('optional_probe_dep')
      expect(noProbe.enabled).toContain('optional_probe_dep')
    })
  })
})
