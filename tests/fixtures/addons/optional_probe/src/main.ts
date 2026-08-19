/**
 * Test fixture: an addon with an *optional* dependency, which degrades instead
 * of failing when that dependency is absent (P14 §6). It records what it saw
 * on `globalThis.__optionalProbe` so a `--eval` expression can report it back
 * through the harness dump.
 *
 * The whole point of the fixture is that this file works unchanged whether
 * `optional_probe_dep` is there or not — the only thing that decides is
 * `api.has()`.
 */

interface ProbeAPI {
  has(id: string): boolean
  deps: {[id: string]: {exports?: {[name: string]: Record<string, unknown>}}}
  exportNamespace?(name: string, exports: Record<string, unknown>): void
}

export interface OptionalProbeReport {
  registered: boolean
  hasDep: boolean
  greeting: string
}

export const addonDefine = {
  name       : 'Optional Probe',
  version    : 1,
  author     : 'tests',
  description: 'fixture addon — optional-dependency probe',
} as const

export function register(api: ProbeAPI) {
  const hasDep = api.has('optional_probe_dep')

  let greeting = 'degraded: optional_probe_dep is absent'
  if (hasDep) {
    const dep = api.deps['optional_probe_dep']?.exports?.['optional_probe_dep'] as
      | {greet(name: string): string}
      | undefined
    greeting = dep ? dep.greet('probe') : 'degraded: dependency loaded but exported nothing'
  }

  const report: OptionalProbeReport = {registered: true, hasDep, greeting}
  ;(globalThis as {__optionalProbe?: OptionalProbeReport}).__optionalProbe = report
}

export function unregister() {
  delete (globalThis as {__optionalProbe?: OptionalProbeReport}).__optionalProbe
}
