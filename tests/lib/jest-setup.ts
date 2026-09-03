/**
 * Per-test-file setup. Loaded via tests/jest.config.ts's `setupFiles`.
 *
 * jsdom doesn't expose Node's TextEncoder/TextDecoder inside its VM context.
 * Bridge them through so modules that use these globals (e.g. storage.ts's
 * readJSON) work in tests.
 *
 * URL.createObjectURL is not implemented in jsdom either, but storage.ts
 * already detects this and falls back to data: URLs which work natively.
 *
 * `fake-indexeddb` is wired up so IndexedDBAddonStorage works in tests.
 */

import {TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder} from 'node:util'

const g = globalThis as any
if (typeof g.TextEncoder !== 'function') g.TextEncoder = NodeTextEncoder
if (typeof g.TextDecoder !== 'function') g.TextDecoder = NodeTextDecoder

// `structuredClone` is a Node 17+ global but jsdom's VM context hides it.
// fake-indexeddb (used by IndexedDBAddonStorage tests) calls it at runtime.
// Polyfill BEFORE fake-indexeddb's auto-installer runs.
//
// Realm gotcha: when the test creates a Uint8Array via Node's util.TextEncoder
// (necessary because jsdom hides TextEncoder), its constructor is Node's
// global Uint8Array — NOT jsdom's. `value instanceof Uint8Array` against
// jsdom's class fails. ArrayBuffer.isView is realm-independent and matches
// all typed arrays + DataView, which is what we need.
if (typeof g.structuredClone !== 'function') {
  g.structuredClone = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (ArrayBuffer.isView(v)) {
      const view = v as ArrayBufferView
      // Copy via the source's constructor so Uint8Array stays Uint8Array,
      // Float32Array stays Float32Array, etc.

      const Ctor = (view as any).constructor as new (b: ArrayBuffer) => unknown
      return new Ctor(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer)
    }
    if (v instanceof ArrayBuffer) return v.slice(0)
    if (Array.isArray(v)) return v.map((x) => g.structuredClone(x))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) {
      out[k] = g.structuredClone((v as Record<string, unknown>)[k])
    }
    return out
  }
}

// jsdom ships no PointerEvent, and path.ux's ui_tabs.ts subclasses it at module
// scope — so any test that imports the pathux barrel dies on import. MouseEvent
// carries everything the class actually reads.
if (typeof g.PointerEvent !== 'function') {
  g.PointerEvent = g.MouseEvent
}

// Side-effect import — installs fake-indexeddb on globalThis at module load.
// Must come AFTER structuredClone is polyfilled.
import 'fake-indexeddb/auto'
