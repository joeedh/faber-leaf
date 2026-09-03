/**
 * Compile-time check that a data-path prefix still reaches the type checker.
 *
 * `container.withDataPrefix<'foo.bar[n].'>()` is what tells the
 * `pathux/valid-datapath` ESLint rule which prefix a container's `prop(...)`
 * calls resolve against; the rule reads the literal off the phantom
 * `__dataPathPrefix` property. Nothing at runtime depends on it, so a
 * `withDataPrefix` that stopped tagging (or a `Container` that dropped the
 * phantom) would widen every prefixed path back to an unchecked suffix match
 * with no other symptom. `npx tsgo --noEmit` fails here instead.
 *
 * The app does not use path.ux's other half — the generated `KnownDataPath`
 * union that types `prop()`'s argument. See tools/gen-datapaths.mjs.
 */
import type {Container} from '../path.ux/scripts/pathux.js'
import type {ShaderNodeDataPrefix} from '../shadernodes/shader_nodes.js'

declare const container: Container

const tagged = container.withDataPrefix<ShaderNodeDataPrefix>()

export const prefixTag: ShaderNodeDataPrefix = tagged.__dataPathPrefix

// @ts-expect-error a bare container carries the empty prefix, not this one
export const untaggedTag: ShaderNodeDataPrefix = container.__dataPathPrefix
