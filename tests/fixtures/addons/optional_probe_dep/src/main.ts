/**
 * Test fixture: the *dependency* half of the P14 optional-addon probe pair.
 *
 * Deliberately trivial — it exists so `optional_probe` has something real to be
 * optionally dependent on, and so a force-disable of a single id has a visible
 * effect. Registers nothing but a namespace, so leaving it enabled in a
 * fixture-inclusive build is inert. See tests/integration/addon_optional_probe.test.ts.
 */

export interface IOptionalProbeDep {
  greet(name: string): string
}

export const addonDefine = {
  name       : 'Optional Probe Dependency',
  version    : 1,
  author     : 'tests',
  description: 'fixture addon — optional-dependency probe',
} as const

export function register(api: {exportNamespace?(name: string, exports: Record<string, unknown>): void}) {
  const exports: IOptionalProbeDep = {
    greet(name: string) {
      return `dep greets ${name}`
    },
  }
  api.exportNamespace?.('optional_probe_dep', exports as unknown as Record<string, unknown>)
}

export function unregister() {}
