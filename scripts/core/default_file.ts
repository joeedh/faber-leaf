/**
 * Default-scene registry.
 *
 * Core only knows how to lay out an empty Scene with a Collection. Anything
 * mesh-shaped that belongs in the startup file (the classic cube) is
 * contributed by whichever addon owns that geometry type, under a name.
 *
 * The name is the point. A distribution names its startup scene and this
 * module reads that name back, so which one wins does not depend on addon load
 * order — the property P17's shuffle test pins. With no distribution active and
 * exactly one scene registered, that one is used, which is what keeps a
 * single-geometry build and the unit tests working without a distribution.
 *
 * `setDefaultSceneBuilder` is a separate, higher-priority override slot for
 * test harnesses that need to route the hook at a throwaway builder.
 */

import {activeDefaultScene} from '../addon/distribution'
import type {ToolContext} from './context'
import type {Library} from './lib_api'
import type {Scene} from '../scene/scene'

export type DefaultSceneBuilder = (ctx: ToolContext, lib: Library, scene: Scene) => void

export interface DefaultSceneEntry {
  name: string
  build: DefaultSceneBuilder
  /** Toolmode the freshly-built file opens in — it belongs to the scene. */
  toolMode?: string
}

const _scenes = new Map<string, DefaultSceneEntry>()
let _override: DefaultSceneBuilder | null = null
let _warnedMissing: string | null = null

/**
 * Contribute a named startup scene. Registering the same name twice replaces
 * the entry; `unregisterDefaultScene` only removes it if it is still the one
 * this builder installed, so a disable cannot clobber a later registration.
 */
export function registerDefaultScene(name: string, build: DefaultSceneBuilder, toolMode?: string): void {
  _scenes.set(name, {name, build, toolMode})
}

export function unregisterDefaultScene(name: string, build: DefaultSceneBuilder): void {
  if (_scenes.get(name)?.build === build) {
    _scenes.delete(name)
  }
}

export function listDefaultScenes(): string[] {
  return [..._scenes.keys()]
}

/** The scene this build actually opens with, or null if that is undecidable. */
export function resolveDefaultScene(): DefaultSceneEntry | null {
  const want = activeDefaultScene()
  if (want !== null) {
    const entry = _scenes.get(want)
    if (!entry && _warnedMissing !== want) {
      _warnedMissing = want
      console.warn(`default scene "${want}" is not registered; starting with an empty scene`)
    }
    return entry ?? null
  }
  return _scenes.size === 1 ? [..._scenes.values()][0] : null
}

/** Override slot: wins over the registry. Test harnesses only. */
export function setDefaultSceneBuilder(fn: DefaultSceneBuilder | null): void {
  _override = fn
}

export function getDefaultSceneBuilder(): DefaultSceneBuilder | null {
  return _override ?? resolveDefaultScene()?.build ?? null
}

/** Toolmode the freshly-built default file activates (if that mode is
 * registered, else gen_default_file falls back to 'object'). */
export function getDefaultToolMode(): string {
  return resolveDefaultScene()?.toolMode ?? 'object'
}

export function buildDefaultSceneContents(ctx: ToolContext, lib: Library, scene: Scene): void {
  getDefaultSceneBuilder()?.(ctx, lib, scene)
}

/** Test-only helper. */
export function _resetDefaultSceneBuilderForTests(): void {
  _scenes.clear()
  _override = null
  _warnedMissing = null
}
