/**
 * Public API surface for the `uv_editor` builtin addon.
 *
 * Reached by peer addons as `@addon/uv_editor/api`. Keep in sync with the
 * `exportNamespace('uv_editor', ...)` call in main.ts — this file is the
 * compile-time half of that runtime namespace, and the two disagreeing is a
 * silent `undefined` at the consumer.
 *
 * It is `index.ts` and nothing else for now: the editor's whole behaviour is
 * the host-free core, and the shell around it has no reusable surface yet.
 */

export * from './index.js'
