/**
 * Backend-pass selection for the split integration run.
 *
 * `tests/integration` runs its suites as TWO jest invocations (see
 * `run-split.mjs`): a WASM pass and a native-N-API pass, selected by the
 * `SC_TEST_BACKEND` env var. Each NW.js launch is a whole Chromium + engine
 * boot, so running both backends inside one invocation doubles the peak
 * process/disk load and makes a native-addon rebuild invalidate the wasm
 * results too.
 *
 * Every suite therefore declares which pass owns it:
 *
 * - per-backend suites (the common case) call `selectedBackends()` and run
 *   their single leg in each pass;
 * - suites that *compare* the backends need both legs live in one process, so
 *   `crossBackends()` / `isCrossBackendPass()` give them entirely to the native
 *   pass (or to the wasm pass when there is no addon to compare against);
 * - backend-agnostic suites call `isDefaultBackendPass()` and run once, in the
 *   wasm pass (an NW.js boot with no `--backend` flag is the wasm app).
 *
 * With `SC_TEST_BACKEND` unset (a plain `jest` invocation) every helper reports
 * "run everything", so a direct jest run behaves exactly as it did before.
 */

export type Backend = 'wasm' | 'native'

/** The requested pass, or undefined for an unsplit run. */
function wanted(): Backend | undefined {
  const want = process.env.SC_TEST_BACKEND
  return want === 'wasm' || want === 'native' ? want : undefined
}

/** The backend legs this pass should run for a per-backend suite. May be empty
 * (native pass with no addon built) — gate the suite's `canRun` on the length. */
export function selectedBackends(haveNative: boolean): Backend[] {
  const all: Backend[] = haveNative ? ['wasm', 'native'] : ['wasm']
  const want = wanted()
  return want ? all.filter((b) => b === want) : all
}

/** `.each` table for `backends`, never empty — jest throws on an empty table,
 * and a suite with no legs is `describe.skip`ped by its `canRun` anyway. */
export function backendTable(backends: Backend[]): (readonly [Backend])[] {
  const legs = backends.length ? backends : (['wasm'] as Backend[])
  return legs.map((b) => [b] as const)
}

/** True in the pass that owns cross-backend (parity) suites: the native pass,
 * or the wasm pass when there is no addon and the comparison self-skips. */
export function isCrossBackendPass(haveNative: boolean): boolean {
  const want = wanted()
  if (!want) return true
  return haveNative ? want === 'native' : want === 'wasm'
}

/** Both legs at once for a cross-backend suite; empty in the pass that doesn't
 * own it (so `canRun` skips the whole file). */
export function crossBackends(haveNative: boolean): Backend[] {
  if (!isCrossBackendPass(haveNative)) return []
  return haveNative ? ['wasm', 'native'] : ['wasm']
}

/** True in the pass that owns backend-agnostic suites (the wasm pass). */
export function isDefaultBackendPass(): boolean {
  return wanted() !== 'native'
}
