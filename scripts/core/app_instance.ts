/**
 * The mounted-instance registry — P20 §2.1.
 *
 * `_appstate` was one global binding, which is the single-instance assumption
 * in its purest form: two apps mounted on one page would fight over it. Call
 * sites move to `getAppState()`, which answers with the instance that is
 * currently active rather than the one that happens to be global.
 *
 * **This module imports nothing, deliberately.** `_appstate` was readable from
 * anywhere without an import, so its replacement has to be too — an accessor
 * that lived in `appstate.ts` would turn every converted read in `core/`,
 * `editors/` or an addon into an import cycle back to it. The `AppStateGlobal`
 * type comes from the ambient declaration in `util/polyfill.d.ts` for the same
 * reason.
 */

const instances: AppStateGlobal[] = []
let active: AppStateGlobal | undefined

/**
 * Registers a freshly constructed instance, and makes it active if it is the
 * first. Registering twice is a no-op, so a re-entrant boot cannot double-list.
 */
export function registerAppInstance(state: AppStateGlobal): void {
  if (instances.includes(state)) {
    return
  }

  instances.push(state)

  if (active === undefined) {
    active = state
  }
}

/**
 * Drops an instance on unmount. If it was the active one, the next surviving
 * instance takes over — an embedder that unmounts one of two must not be left
 * with `getAppState()` throwing.
 */
export function unregisterAppInstance(state: AppStateGlobal): void {
  const i = instances.indexOf(state)
  if (i < 0) {
    return
  }

  instances.splice(i, 1)

  if (active === state) {
    active = instances[0]
  }
}

/** Makes `state` the one `getAppState()` answers with. It must be registered. */
export function setActiveAppInstance(state: AppStateGlobal): void {
  if (!instances.includes(state)) {
    throw new Error('setActiveAppInstance: instance is not registered')
  }

  active = state
}

/**
 * The active instance. Throws rather than returning `undefined`, because every
 * call site this replaces read a global that was assumed to exist — a thrown
 * error names the bug, a silent `undefined` produces one two frames later.
 */
export function getAppState(): AppStateGlobal {
  if (active === undefined) {
    throw new Error('getAppState: no app instance is mounted')
  }

  return active
}

/** The active instance, or `undefined` before the first mount. */
export function peekAppState(): AppStateGlobal | undefined {
  return active
}

/** Every mounted instance, in mount order. */
export function listAppInstances(): readonly AppStateGlobal[] {
  return instances
}

/** Runs `fn` with `state` active, restoring the previous instance afterwards. */
export function withAppInstance<T>(state: AppStateGlobal, fn: () => T): T {
  const prev = active
  active = state

  try {
    return fn()
  } finally {
    active = prev
  }
}
