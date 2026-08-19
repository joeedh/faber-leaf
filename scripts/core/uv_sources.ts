/**
 * Registry of UV sources, keyed by data kind.
 *
 * `IUVSource` lives in `core/geometry_contract.ts`; this is the only way to
 * reach an implementation of it, so the UV editor's gate and its call path
 * cannot disagree.
 *
 * It is a resolver rather than a capability narrow (the shape used by every
 * other optional capability in `core/data_kinds.ts`) because a UV source need
 * not be the geometry object itself: a provider may hand back an adapter over a
 * cached unwrap. One lookup path, so the editor's gate and its call path cannot
 * disagree.
 */

import type {GeometryDataRef, IUVSource} from './geometry_contract'
import {resolveKindId} from './geometry_contract'

export interface IUVSourceProvider {
  /** Data kind this provider serves, e.g. 'litemesh'. */
  kindId: string

  /** Optional label for UI that lists what can be unwrapped. */
  uiName?: string

  /** The source for one data instance, or undefined if it currently has none. */
  resolve(data: GeometryDataRef): IUVSource | undefined
}

const _providers = new Map<string, IUVSourceProvider>()

export function registerUVSource(provider: IUVSourceProvider): void {
  if (_providers.has(provider.kindId)) {
    throw new Error(`UV source for kind "${provider.kindId}" is already registered`)
  }
  _providers.set(provider.kindId, provider)
}

export function unregisterUVSource(kindId: string): void {
  _providers.delete(kindId)
}

export function listUVSources(): IUVSourceProvider[] {
  return Array.from(_providers.values())
}

/** The UV source for a data instance, or undefined if its kind has none. */
export function uvSourceFor(data: GeometryDataRef | undefined): IUVSource | undefined {
  if (!data) {
    return undefined
  }

  const id = resolveKindId(data)
  return id ? _providers.get(id)?.resolve(data) : undefined
}

/** Test-only helper. */
export function _resetUVSourcesForTests(): void {
  _providers.clear()
}
