/**
 * Where an implementor leaves a way to build a fresh `IUVSource` — P19 §5 step 7.
 *
 * The unwrap parity check lives in the UV editor addon; the sources live in the
 * geometry addons; addons may not import each other. So each implementor
 * registers a factory here under a name, and the checker asks for it by name.
 * The registry sits on `globalThis` for the same reason
 * `uv_source_conformance.ts`'s result does: the two halves are separate bundles
 * that only meet inside the running app.
 */

import type {IUVSource} from './geometry_contract.js'

/** A source, plus whatever has to be released once the caller is done with it. */
export interface UVSourceFixture {
  source: IUVSource

  /** A LiteMesh owns C++ allocations no GC reaches; a LeafMesh needs nothing. */
  dispose?(): void
}

export type UVSourceFixtureFactory = () => UVSourceFixture

interface FixtureGlobal {
  __uvsourceFixtures?: Map<string, UVSourceFixtureFactory>
}

function registry(): Map<string, UVSourceFixtureFactory> {
  const g = globalThis as FixtureGlobal
  if (!g.__uvsourceFixtures) {
    g.__uvsourceFixtures = new Map()
  }
  return g.__uvsourceFixtures
}

/** Called from an addon's test-support module, at module-eval time. */
export function registerUVSourceFixture(name: string, make: UVSourceFixtureFactory): void {
  registry().set(name, make)
}

/** Registered names, sorted, so a run order does not depend on addon load order. */
export function uvSourceFixtureNames(): string[] {
  return [...registry().keys()].sort()
}

/**
 * Build `name`'s fixture, hand the source to `fn`, and dispose it either way.
 * Throws when nothing registered that name — in a build without sculptcore the
 * LiteMesh fixture is genuinely absent, and a caller has to say what it does
 * about that rather than silently skip.
 */
export function withUVSourceFixture<T>(name: string, fn: (source: IUVSource) => T): T {
  const make = registry().get(name)
  if (!make) {
    throw new Error(`no UV source fixture named '${name}'`)
  }

  const fixture = make()
  try {
    return fn(fixture.source)
  } finally {
    fixture.dispose?.()
  }
}
