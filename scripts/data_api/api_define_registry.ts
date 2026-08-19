/**
 * Dependency-free registry of the classes that participate in the data API.
 *
 * Kept separate from `api_define.ts` to avoid a cycle: `api_define.ts` imports
 * every participating class, so were it to also own `registerDataAPI`, a class
 * importing it back (`class → api_define → class`) would touch the registry in its
 * temporal dead zone and crash. This leaf has no app imports, so its array is
 * initialized before any class module runs and registration order is irrelevant.
 */
import type {DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'

/**
 * Data-API definition contract: a static `defineAPI(api, struct?)` that declares
 * and returns the class's `DataStruct`. `struct` defaults to `api.mapStruct(this)`;
 * subclasses chain base props via `super.defineAPI(api, struct)`.
 */
export type DefineAPIClass = (abstract new (...args: any[]) => any) & {
  defineAPI(api: DataAPI, struct?: DataStruct): DataStruct
}

const dataAPIRegistry: DefineAPIClass[] = []

/**
 * Register a class so its `defineAPI` runs while the data API is built. Idempotent.
 * Core classes call this at module scope; builtin-addon classes via the
 * own `register(api)` hook, via `addon_base.ts`'s dispatcher.
 */
export function registerDataAPI(cls: DefineAPIClass): void {
  if (!dataAPIRegistry.includes(cls)) {
    dataAPIRegistry.push(cls)
  }
}

/** The classes registered via {@link registerDataAPI}, in registration order. */
export function getDataAPIRegistry(): readonly DefineAPIClass[] {
  return dataAPIRegistry
}

/**
 * Classes whose `defineAPI` has already run against the live API. Shared by
 * `getDataAPI()`'s build pass and `addon_base.ts`'s dispatcher (which live-defines a
 * late-enabled addon's classes) so nothing — e.g. `Mesh` — is ever defined twice.
 */
const _definedDataAPI = new WeakSet<DefineAPIClass>()

/** True once {@link markDataAPIDefined} has recorded `cls`. */
export function isDataAPIDefined(cls: DefineAPIClass): boolean {
  return _definedDataAPI.has(cls)
}

/** Record that `cls`'s `defineAPI` has been run against the live API. */
export function markDataAPIDefined(cls: DefineAPIClass): void {
  _definedDataAPI.add(cls)
}

// ---------------------------------------------------------------------------
// Contributions: the two things a provider needs that a bare class list cannot
// express — a struct attached under the ToolContext tree, and a non-class
// builder that has to run at a specific point in `getDataAPI()`'s three passes.
// ---------------------------------------------------------------------------

/**
 * A named subtree under the `ToolContext` struct: `ctx.mesh`, `ctx.scene`, …
 * The provider names the class; `getDataAPI()` resolves it by reference, so the
 * attach is mangle-proof and needs no stable string name.
 */
export interface ContextStructContribution {
  /** Path under `ToolContext`, e.g. `'mesh'`. Also the contribution's id. */
  path: string
  uiName: string
  cls: DefineAPIClass
}

const contextStructs = new Map<string, ContextStructContribution>()

export function registerContextStruct(contribution: ContextStructContribution): void {
  if (contextStructs.has(contribution.path)) {
    throw new Error(`context struct "${contribution.path}" is already registered`)
  }
  contextStructs.set(contribution.path, contribution)
}

export function unregisterContextStruct(path: string): void {
  contextStructs.delete(path)
}

/** Sorted by path: attach order is not load-bearing and must not vary. */
export function getContextStructs(): ContextStructContribution[] {
  return Array.from(contextStructs.values()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * When a builder runs relative to the pass that calls every registered class's
 * `defineAPI`. `before-classes` is for structs a class attaches *by reference*
 * (they must already exist); `after-classes` is for builders that chain from a
 * populated class struct.
 */
export type DataAPIBuildPhase = 'before-classes' | 'after-classes'

export interface DataAPIBuilder {
  /** Unique id, also the sort key within a phase. */
  id: string
  phase: DataAPIBuildPhase
  build(api: DataAPI): void
}

const dataAPIBuilders = new Map<string, DataAPIBuilder>()

export function registerDataAPIBuilder(builder: DataAPIBuilder): void {
  if (dataAPIBuilders.has(builder.id)) {
    throw new Error(`data-API builder "${builder.id}" is already registered`)
  }
  dataAPIBuilders.set(builder.id, builder)
}

export function unregisterDataAPIBuilder(id: string): void {
  dataAPIBuilders.delete(id)
}

/** Sorted by id within the phase, for the same reason as {@link getContextStructs}. */
export function getDataAPIBuilders(phase: DataAPIBuildPhase): DataAPIBuilder[] {
  return Array.from(dataAPIBuilders.values())
    .filter((b) => b.phase === phase)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Test-only helper — clears both contribution registries. */
export function _resetDataAPIContributionsForTests(): void {
  contextStructs.clear()
  dataAPIBuilders.clear()
}
