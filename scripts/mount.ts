/**
 * The embedding entry point. `mountFaberLeaf` puts one app instance inside a
 * container element and hands back a handle that can take it down again; the
 * shipped shells (index.html, nwjs/window.html) boot through it, so an embedder
 * runs the same path the product does. See documentation/embedding.md.
 */

import addon, {startAddons} from './addon/addon.js'
import config from './config/config.js'
import type {Distribution} from './addon/distribution.js'
import {AppState, initProcessGlobals} from './core/appstate.js'
import {
  getAppState,
  listAppInstances,
  peekAppState,
  registerAppInstance,
  setActiveAppInstance,
  unregisterAppInstance,
} from './core/app_instance.js'
import {getAppStorage} from './core/app_storage.js'
import {migrateAppIdentity} from './core/identity_migration.js'
import {nstructjs} from './path.ux/pathux.js'
import {setupPathux} from './setup_pathux.js'

export interface MountOptions {
  /**
   * The product this page mounts (P17): which addons ship, which scene opens,
   * what the window is called. Read once, by the first mount on the page.
   */
  distribution?: Distribution
  /** Explicit icon-sheet URL; see setupPathux. Process-wide, first mount wins. */
  iconSheetUrl?: string
  /** Open the built-in default scene. False leaves the instance empty. */
  loadDefaultFile?: boolean
  /** Make this the instance `getAppState()` returns. Defaults to true. */
  activate?: boolean
}

export interface FaberLeafInstance {
  /** The mounted app state. Not part of the stable embedding surface. */
  readonly state: AppState
  readonly container: HTMLElement
  /** Route `getAppState()` (and the globals built on it) to this instance. */
  activate(): void
  /** Release the DOM, GPU resources, listeners, timers and registry entry. */
  unmount(): void
}

/** Process-wide boot, run once per page however many instances mount. */
let processBoot: Promise<void> | undefined

async function bootProcess(options: MountOptions): Promise<void> {
  // Must run before anything reads the startup scene, settings or the installed
  // addon list, i.e. before startAddons(). Never throws.
  await migrateAppIdentity(getAppStorage())

  await setupPathux({iconSheetUrl: options.iconSheetUrl})

  nstructjs.setWarningMode(0)
  nstructjs.validateStructs()

  // Declares the distribution's in-bundle addons as sources and installs its
  // allow-list, startup scene and title. Must precede startAddons().
  if (options.distribution !== undefined) {
    addon.loadDistribution(options.distribution)
  }

  // Await the unified pipeline so every addon's toolmodes/editors/datablocks
  // are registered + enabled before we build the UI. It also awaits each
  // addon's boot task, so any engine an addon needs (e.g. sculptcore's WASM)
  // is warm before the instance reads the startup file.
  await startAddons(true)

  // Legacy grace period for addon sources that register on their own schedule.
  const wait = config.addonLoadWaitTime ?? 500
  if (wait > 0) {
    await new Promise<void>((accept) => window.setTimeout(accept, wait))
  }

  initProcessGlobals()
  installConsoleShortcut()
}

/** `CTX` in the devtools console / the --eval harness. See debugSurface.md. */
function installConsoleShortcut(): void {
  if (typeof (globalThis as {CTX?: unknown}).CTX !== 'undefined') {
    return
  }

  Object.defineProperty(window, 'CTX', {
    configurable: true,
    get         : () => getAppState().ctx,
  })
}

export async function mountFaberLeaf(
  container: HTMLElement = document.body,
  options: MountOptions = {}
): Promise<FaberLeafInstance> {
  const state = new AppState()
  state.container = container
  // One autosave slot per app identity, so only the first instance may arm it.
  state.enableAutosave = listAppInstances().length === 0

  registerAppInstance(state)
  if (options.activate !== false) {
    setActiveAppInstance(state)
  }

  // Deprecated alias to the first-mounted instance, kept for console use, the
  // CDP harness and the e2e suites. documentation/embedding.md dates its
  // removal.
  if (window._appstate === undefined) {
    window._appstate = state
  }

  // Addons registered during boot call getAppState(), so the instance has to be
  // registered first — which is why the process boot is awaited from inside the
  // mount rather than ahead of it.
  if (processBoot === undefined) {
    processBoot = bootProcess(options)
  }
  await processBoot

  state.start(options.loadDefaultFile ?? true)

  let mounted = true

  return {
    state,
    container,

    activate(): void {
      setActiveAppInstance(state)
    },

    unmount(): void {
      if (!mounted) {
        return
      }
      mounted = false

      state.destroy()
      unregisterAppInstance(state)

      if (window._appstate === state) {
        window._appstate = peekAppState() as AppState
      }
    },
  }
}

/** Every instance currently mounted on this page, in mount order. */
export function mountedInstances(): readonly AppState[] {
  return listAppInstances() as readonly AppState[]
}
