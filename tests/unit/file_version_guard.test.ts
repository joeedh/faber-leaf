/**
 * The forward-compatibility guard for `.wproj` files (P10 §6a, plan
 * documentation/plans/2026-08-15-0345-serialization-and-file-compat-hardening.md).
 *
 * `AppState.loadFile_start` classifies a file whose version is newer than this
 * build's before it decodes anything; this covers the classification itself.
 * That a newer-but-readable file really does open is asserted end-to-end in
 * `tests/integration/file_compat.test.ts`.
 */

import {APP_VERSION, BREAKING_FILE_VERSIONS, isBreakingFileVersion} from '../../scripts/core/const'

describe('isBreakingFileVersion', () => {
  test('this build and anything older are never breaking', () => {
    expect(isBreakingFileVersion(APP_VERSION)).toBe(false)
    expect(isBreakingFileVersion(APP_VERSION - 1)).toBe(false)
    expect(isBreakingFileVersion(0)).toBe(false)
  })

  test('a newer file is readable unless a break sits between the two', () => {
    // The default list is empty, so today every newer file is merely "newer".
    expect(isBreakingFileVersion(APP_VERSION + 1)).toBe(false)
    expect(isBreakingFileVersion(APP_VERSION + 50)).toBe(false)
  })

  test('a declared break makes that version and everything after it unreadable', () => {
    const breaking = [APP_VERSION + 2]

    expect(isBreakingFileVersion(APP_VERSION + 1, breaking)).toBe(false)
    expect(isBreakingFileVersion(APP_VERSION + 2, breaking)).toBe(true)
    expect(isBreakingFileVersion(APP_VERSION + 3, breaking)).toBe(true)
  })

  test('a break at or below what this build reads is already honoured, not refused', () => {
    // A build that ships the break reads its own files; the list only ever
    // describes versions ahead of `reads`.
    expect(isBreakingFileVersion(APP_VERSION, [APP_VERSION])).toBe(false)
    expect(isBreakingFileVersion(APP_VERSION + 1, [APP_VERSION - 1])).toBe(false)
  })

  test('the shipped list stays empty until a change is genuinely one-way', () => {
    // Files carry their own struct schema, so most bumps are not breaks. This
    // asserts the intent, not an invariant: adding a real break updates it.
    expect(BREAKING_FILE_VERSIONS).toEqual([])
  })
})
