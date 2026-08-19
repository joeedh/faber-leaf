/**
 * Distributions: the app's composition root.
 *
 * A distribution declares which addons ship, which startup scene opens, and
 * what the window is called. `faber-leaf` is the full product; `faber-leaf-core`
 * is the same tree without sculptcore. They differ only in their manifest.
 *
 * **A distribution is a manifest, not a fork.** Nothing in `distributions/*` may
 * contain product logic — if something needs to differ beyond the addon set,
 * the startup scene or the branding, that is a missing addon boundary and it
 * gets fixed in the addon. A distribution file over ~50 lines is a smell.
 * See documentation/plans/2026-08-15-0420-w5-distributions.md §3.
 *
 * The addon list is an **allow-list**: a first-party addon the distribution
 * omits is never loaded at all — no module import, no record — the same state
 * `force_disable.ts` produces, so `api.has(id)` is correct by construction.
 * Third-party addons the user installed are not filtered; they were an explicit
 * user choice, not a shipping decision.
 *
 * This module imports nothing, deliberately: it is read by the addon manager
 * *and* by core's default-scene registry, and an import of either would put it
 * inside the host's cycle knot. `manifest` and `module` are therefore `unknown`
 * — the manager casts them, since it is the one that knows what they are.
 */

export interface DistributionAddon {
  id: string
  /** In-bundle builtins only: the manifest.json contents and the entry module. */
  manifest?: unknown
  module?: unknown
  /** Overrides the manifest's `defaultEnabled` for this distribution. */
  enabled?: boolean
}

export interface Distribution {
  /** Matches the directory under distributions/ and `--distribution <id>`. */
  id: string
  /** Window / document title. */
  title: string
  addons: DistributionAddon[]
  /** Name of a scene registered via `registerDefaultSceneBuilder`; omit for an empty startup file. */
  defaultScene?: string
}

/** Identity, for the type-checking and the grep-ability. */
export function defineDistribution(def: Distribution): Distribution {
  return def
}

/**
 * An addon compiled into the main bundle: pass its `manifest.json` import and
 * its `@builtin/<id>` namespace. When the addon is not in this build that
 * namespace is the unavailable-builtin stub, and `registerBuiltin` records it
 * as not-in-build rather than enabling a shell of it.
 */
export function bundled(manifest: {id: string}, module: unknown, opts: {enabled?: boolean} = {}): DistributionAddon {
  return {id: manifest.id, manifest, module, enabled: opts.enabled}
}

/** An addon that arrives at runtime through `build/addons/index.json`. */
export function external(id: string, opts: {enabled?: boolean} = {}): DistributionAddon {
  return {id, enabled: opts.enabled}
}

let active: Distribution | null = null
let allowed: Map<string, DistributionAddon> | null = null

/** Called by AddonManager.loadDistribution; nothing else should set this. */
export function setActiveDistribution(dist: Distribution | null): void {
  active = dist
  allowed = dist ? new Map(dist.addons.map((a) => [a.id, a])) : null
}

export function getActiveDistribution(): Distribution | null {
  return active
}

/** The startup scene this distribution asked for; null when none is active. */
export function activeDefaultScene(): string | null {
  return active?.defaultScene ?? null
}

/** True when no distribution is active (tests, harnesses) or it lists this id. */
export function isInDistribution(id: string): boolean {
  return allowed === null || allowed.has(id)
}

/** The distribution's `enabled` override for this id, or undefined to follow the manifest. */
export function distributionEnabled(id: string): boolean | undefined {
  return allowed?.get(id)?.enabled
}
