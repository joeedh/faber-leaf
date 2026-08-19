/**
 * Boot-time addon force-disable.
 *
 * A force-disabled addon is not "loaded but off" — it is never loaded at all:
 * no module import, no record, absent from `idmap`. That is the state a
 * distribution which omits the addon is actually in, and it is what makes
 * `api.has(id)` correct without every caller having to distinguish loaded from
 * enabled. See documentation/addons.md and P14 §10.2 D1.
 *
 * Three sources, unioned and read once:
 *
 *   - `?disableAddons=a,b` on the URL (browser, and NW.js via its page URL);
 *   - `localStorage.disabledAddons` — same comma-separated form;
 *   - `--disable-addon=<id>` on the command line, repeatable, also accepting a
 *     comma-separated list (NW.js shell and the headless harness).
 */

import {getArgList} from '../core/app_argv'

const QUERY_PARAM = 'disableAddons'
const STORAGE_KEY = 'disabledAddons'
const CLI_FLAG = 'disable-addon'

let cached: Set<string> | undefined

function splitIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function detect(): Set<string> {
  const ids = new Set<string>()

  if (typeof location !== 'undefined') {
    for (const id of splitIds(new URLSearchParams(location.search).get(QUERY_PARAM))) {
      ids.add(id)
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      for (const id of splitIds(localStorage.getItem(STORAGE_KEY))) {
        ids.add(id)
      }
    } catch {
      // A storage-denied context (file://, privacy mode) is not a boot failure.
    }
  }

  for (const value of getArgList(CLI_FLAG)) {
    for (const id of splitIds(value)) {
      ids.add(id)
    }
  }

  return ids
}

/** The set of addon ids that must not load in this session. Cached. */
export function getForceDisabledIds(): Set<string> {
  if (cached === undefined) cached = detect()
  return cached
}

/** True if this id is force-disabled for this session. */
export function isForceDisabled(id: string): boolean {
  return getForceDisabledIds().has(id)
}

/**
 * Overrides the detected set — for tests, and for a host that decides its own
 * distribution. Pass `undefined` to go back to re-detecting from the three
 * sources.
 */
export function setForceDisabledIds(ids: Iterable<string> | undefined): void {
  cached = ids === undefined ? undefined : new Set(ids)
}
