/**
 * Test fixture: requires an addon that is not in any distribution. The resolver
 * must partition it off with a recorded reason and let the app boot; if this
 * file's `register` ever runs, the resolver let a broken dependency through.
 */

export const addonDefine = {
  name       : 'Optional Probe (missing requirement)',
  version    : 1,
  author     : 'tests',
  description: 'fixture addon — must never load',
} as const

export function register() {
  ;(globalThis as {__optionalProbeBrokenRan?: boolean}).__optionalProbeBrokenRan = true
}

export function unregister() {}
