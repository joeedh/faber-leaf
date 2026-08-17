/**
 * Addon-contributed keymaps, keyed by the id of the editor keymap they extend
 * (`'view3d'` today). An editor's `getKeyMaps()` appends
 * {@link getKeymapEntries} to its own, so a contribution appears and disappears
 * with the addon that made it, without any keymap rebuild.
 *
 * A host default keymap must never name an addon's ToolOp: the hotkey then
 * exists whether or not the tool does. See documentation/geometry-contract.md §9.
 *
 * Like the other §9 registries this module stays a leaf — it holds path.ux
 * `KeyMap` objects and knows nothing about who registers them.
 */

import type {KeyMap} from '../path.ux/scripts/pathux.js'

interface Contribution {
  ownerId: string
  keymapId: string
  keymap: KeyMap
}

const contributions: Contribution[] = []

/**
 * Contribute a keymap under `keymapId`. `ownerId` is the addon id, and is what
 * {@link unregisterKeymapEntries} removes by — one owner may contribute to
 * several keymaps.
 */
export function registerKeymapEntries(keymapId: string, ownerId: string, keymap: KeyMap): void {
  contributions.push({ownerId, keymapId, keymap})
}

export function unregisterKeymapEntries(ownerId: string, keymapId?: string): void {
  for (let i = contributions.length - 1; i >= 0; i--) {
    const c = contributions[i]
    if (c.ownerId === ownerId && (keymapId === undefined || c.keymapId === keymapId)) {
      contributions.splice(i, 1)
    }
  }
}

/** Sorted by owner id, so dispatch order does not depend on addon load order. */
export function getKeymapEntries(keymapId: string): KeyMap[] {
  return contributions
    .filter((c) => c.keymapId === keymapId)
    .sort((a, b) => (a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0))
    .map((c) => c.keymap)
}

/** Test-only helper — clears the registry. */
export function _resetKeymapContributionsForTests(): void {
  contributions.length = 0
}
