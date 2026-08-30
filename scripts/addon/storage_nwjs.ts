/**
 * NW.js-side wiring for NodeFsAddonStorage.
 *
 * The NW.js build runs Node and the browser in one context, so the renderer has
 * direct access to `require('fs/promises')` and `require('path')` — and to
 * `nw.App.dataPath` for the per-app data directory. We back NodeFsAddonStorage
 * with that directly; no IPC and no main process are involved.
 *
 * Usage in code that boots the addon system:
 *
 *     if (window.haveNwjs) {
 *       const storage = await createNwjsAddonStorage()
 *       addonManager.setStorage(storage)
 *     }
 */

import {NodeFsAddonStorage} from './storage.js'

type RequireFn = (id: string) => any

declare global {
  interface Window {
    /** Set by nwjs/window.html when running under NW.js. */
    haveNwjs?: boolean
  }

  var nw: {App: {dataPath: string}} | undefined
}

/**
 * Builds a NodeFsAddonStorage rooted at `<nw.App.dataPath>/addons` in the NW.js
 * renderer. Throws if called outside NW.js or if `require` isn't available.
 */
export async function createNwjsAddonStorage(): Promise<NodeFsAddonStorage> {
  const req = (globalThis as any).require as RequireFn | undefined
  if (typeof req !== 'function') {
    throw new Error('createNwjsAddonStorage: require() not available — is this NW.js?')
  }

  // We're inside NW.js so these requires succeed at runtime. TypeScript can't
  // resolve them without @types/node; the casts are deliberate.

  const fsp = req('fs/promises') as any

  const pathlib = req('path') as any

  // NW.js owns the per-app data directory; read it directly (no IPC).
  const userData = (globalThis as {nw?: {App: {dataPath: string}}}).nw!.App.dataPath
  const baseDir = pathlib.join(userData, 'addons')

  return new NodeFsAddonStorage({
    baseDir,
    fs: fsp,
    pathlib,
  })
}
