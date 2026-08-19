/**
 * Addon manifest schema + validator.
 *
 * Every addon (builtin or third-party) ships a `manifest.json` declaring its
 * id, version, dependencies, and entry point. The loader parses these, builds
 * a dependency graph, and topologically orders the loads. See plan §2.2 and §2.5.
 *
 * What "optional" means across the manifest, the resolver and the boot path is
 * normative in documentation/addons.md; P14 §10.2 records why.
 */

export interface IAddonManifest {
  /** Stable id matching the addon's directory name (kebab-case or snake_case). */
  id: string

  /** Human-readable name shown in the addon UI. */
  name: string

  /** Semantic version "MAJOR.MINOR.PATCH". */
  version: string

  /** Optional author string. */
  author?: string

  /** Entry file relative to the manifest. For builtin addons this is the .ts
   * source (e.g. "src/main.ts") that tools/build-addons.js compiles. For
   * third-party addons it's the prebuilt .js (e.g. "build/main.js"). */
  entry: string

  /** Ids of addons this addon depends on. Loaded before this one. */
  dependencies?: string[]

  /** Optional permission tags. Reserved for future use. */
  permissions?: string[]

  /** Optional description. */
  description?: string

  /** Optional icon path or pathux icon enum value. */
  icon?: string | number

  /** Build mode for third-party addons: prebuilt JS or TS source compiled at
   * install time. Builtin addons always use 'prebuilt' implicitly (built by
   * the project's build step). See plan §2.3. */
  buildMode?: 'prebuilt' | 'source'

  /** Whether the addon is enabled out-of-the-box (no persisted user pref).
   * Defaults to true; set false for addons that should ship disabled. */
  defaultEnabled?: boolean

  /** May a build ship without this addon, and may the user turn it off? An
   * optional addon's absence is a normal state; a required one's is a defect.
   * Defaults to false. */
  optional?: boolean

  /** Ids loaded before this one *when present*. Unlike `dependencies`, an
   * absent entry does not disable this addon — it loads degraded and asks
   * `api.has(id)`. */
  optionalDependencies?: string[]
}

/**
 * Every field the schema knows. An unrecognised key is an error: `optional`
 * spent this project's whole history being silently dropped, and a validator
 * that ignores what it does not understand is how that happens.
 */
const KNOWN_FIELDS = new Set([
  'id',
  'name',
  'version',
  'author',
  'entry',
  'dependencies',
  'permissions',
  'description',
  'icon',
  'buildMode',
  'defaultEnabled',
  'optional',
  'optionalDependencies',
])

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly manifestPath: string | undefined
  ) {
    super(manifestPath ? `${manifestPath}: ${message}` : message)
    this.name = 'ManifestValidationError'
  }
}

const ID_RE = /^[a-z][a-z0-9_-]*$/
const VERSION_RE = /^\d+\.\d+\.\d+$/

/**
 * Parses + validates a manifest object. Returns the typed manifest on success;
 * throws `ManifestValidationError` on any schema problem. `manifestPath` is
 * used only for error messages.
 */
export function validateManifest(raw: unknown, manifestPath?: string): IAddonManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestValidationError('manifest must be a JSON object', manifestPath)
  }
  const m = raw as Record<string, unknown>

  const unknown = Object.keys(m).filter((k) => !KNOWN_FIELDS.has(k))
  if (unknown.length > 0) {
    throw new ManifestValidationError(
      `unknown manifest field(s): ${unknown.map((k) => JSON.stringify(k)).join(', ')}`,
      manifestPath
    )
  }

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    throw new ManifestValidationError(
      `"id" must be a lowercase identifier matching ${ID_RE} (got ${JSON.stringify(m.id)})`,
      manifestPath
    )
  }
  if (typeof m.name !== 'string' || m.name.length === 0) {
    throw new ManifestValidationError('"name" must be a non-empty string', manifestPath)
  }
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) {
    throw new ManifestValidationError(
      `"version" must be semver MAJOR.MINOR.PATCH (got ${JSON.stringify(m.version)})`,
      manifestPath
    )
  }
  if (typeof m.entry !== 'string' || m.entry.length === 0) {
    throw new ManifestValidationError('"entry" must be a non-empty string', manifestPath)
  }
  if (m.entry.includes('..')) {
    throw new ManifestValidationError('"entry" must not contain ".."', manifestPath)
  }

  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const v = m[field]
    if (v === undefined) continue
    if (!Array.isArray(v) || v.some((d) => typeof d !== 'string')) {
      throw new ManifestValidationError(`"${field}" must be an array of strings`, manifestPath)
    }
    for (const d of v as string[]) {
      if (!ID_RE.test(d)) {
        throw new ManifestValidationError(
          `${field} id ${JSON.stringify(d)} does not match ${ID_RE}`,
          manifestPath
        )
      }
    }
  }

  const bothLists = new Set(((m.dependencies as string[] | undefined) ?? []).filter((d) =>
    ((m.optionalDependencies as string[] | undefined) ?? []).includes(d)
  ))
  if (bothLists.size > 0) {
    throw new ManifestValidationError(
      `${[...bothLists].map((d) => JSON.stringify(d)).join(', ')} listed as both a required and an optional dependency`,
      manifestPath
    )
  }

  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.some((p) => typeof p !== 'string')) {
      throw new ManifestValidationError('"permissions" must be an array of strings', manifestPath)
    }
  }

  if (m.buildMode !== undefined && m.buildMode !== 'prebuilt' && m.buildMode !== 'source') {
    throw new ManifestValidationError(
      `"buildMode" must be "prebuilt" or "source" (got ${JSON.stringify(m.buildMode)})`,
      manifestPath
    )
  }

  for (const field of ['defaultEnabled', 'optional'] as const) {
    if (m[field] !== undefined && typeof m[field] !== 'boolean') {
      throw new ManifestValidationError(`"${field}" must be a boolean`, manifestPath)
    }
  }

  return {
    id            : m.id as string,
    name          : m.name as string,
    version       : m.version as string,
    author        : typeof m.author === 'string' ? m.author : undefined,
    entry         : m.entry as string,
    dependencies  : (m.dependencies as string[] | undefined) ?? [],
    permissions   : m.permissions as string[] | undefined,
    description   : typeof m.description === 'string' ? m.description : undefined,
    icon          : (m.icon as string | number | undefined) ?? undefined,
    buildMode           : (m.buildMode as 'prebuilt' | 'source' | undefined) ?? 'prebuilt',
    defaultEnabled      : (m.defaultEnabled as boolean | undefined) ?? true,
    optional            : (m.optional as boolean | undefined) ?? false,
    optionalDependencies: (m.optionalDependencies as string[] | undefined) ?? [],
  }
}

/** Why an addon in the input set did not make it into the load order. */
export interface DisabledAddon {
  id: string
  reason: 'missing-dep' | 'dep-disabled'
  /** The dependency that was absent, or the disabled one this addon required. */
  dependency: string
  message: string
}

/** The resolver's partition: what loads, in order, and what does not, with why. */
export interface ManifestResolution {
  loaded: IAddonManifest[]
  disabled: DisabledAddon[]
}

/**
 * Orders manifests so dependencies load before dependents, and partitions off
 * the ones that cannot load.
 *
 * A missing *required* dependency disables the dependent (and, transitively,
 * whatever required it) with a recorded reason — it does not throw, because one
 * absent addon must not take the whole app down. A cycle or a duplicate id
 * still throws: those are programming errors, not configuration states.
 * `optionalDependencies` order but never satisfy. See P14 §10.2 D2/D3.
 *
 * Order is a function of the manifest set alone — roots are visited in id
 * order — so it does not inherit `storage.list()`'s filesystem ordering.
 */
export function resolveManifests(manifests: IAddonManifest[]): ManifestResolution {
  const byId = new Map<string, IAddonManifest>()
  for (const m of manifests) {
    if (byId.has(m.id)) {
      throw new Error(`duplicate addon id "${m.id}"`)
    }
    byId.set(m.id, m)
  }

  const state = new Map<string, 'in-progress' | 'loaded' | 'disabled'>()
  const loaded: IAddonManifest[] = []
  const disabled: DisabledAddon[] = []

  const reject = (m: IAddonManifest, d: DisabledAddon) => {
    state.set(m.id, 'disabled')
    disabled.push(d)
  }

  const visit = (m: IAddonManifest, stack: string[]): 'loaded' | 'disabled' => {
    const seen = state.get(m.id)
    if (seen === 'loaded' || seen === 'disabled') return seen
    if (seen === 'in-progress') {
      throw new Error(`addon dependency cycle: ${[...stack, m.id].join(' -> ')}`)
    }
    state.set(m.id, 'in-progress')

    // Optional deps order but never satisfy: visit for placement, ignore the
    // verdict.
    for (const depId of [...(m.optionalDependencies ?? [])].sort()) {
      const dep = byId.get(depId)
      if (dep) visit(dep, [...stack, m.id])
    }

    for (const depId of m.dependencies ?? []) {
      const dep = byId.get(depId)
      if (!dep) {
        reject(m, {
          id        : m.id,
          reason    : 'missing-dep',
          dependency: depId,
          message   : `addon "${m.id}" requires "${depId}", which is not available`,
        })
        return 'disabled'
      }
      if (visit(dep, [...stack, m.id]) === 'disabled') {
        reject(m, {
          id        : m.id,
          reason    : 'dep-disabled',
          dependency: depId,
          message   : `addon "${m.id}" requires "${depId}", which is itself disabled`,
        })
        return 'disabled'
      }
    }

    state.set(m.id, 'loaded')
    loaded.push(m)
    return 'loaded'
  }

  for (const id of [...byId.keys()].sort()) {
    visit(byId.get(id)!, [])
  }
  return {loaded, disabled}
}
