/**
 * Compile-time checks that a data-path prefix resolves to the paths under it.
 *
 * `container.withDataPrefix<'foo.bar[n].'>()` is what gives `prop(...)` its
 * autocomplete and gives the `pathux/valid-datapath` ESLint rule the prefix to
 * check against. Both depend on the generated `IndexedDataPathRegistry`, which
 * `pnpm gen:paths` writes to generated/datapaths.ts — if that emission or
 * `PathsUnderPrefix` breaks, the prefix silently widens to `string` and every
 * path under it stops being checked. `npx tsgo --noEmit` fails here instead.
 */
import type {PathsUnderPrefix} from '../path.ux/scripts/core/datapath_registry'

/** Drops the `string & {}` arm that keeps runtime-resolved paths assignable. */
type OnlyLiterals<T> = T extends string ? (string extends T ? never : T) : never

type ShaderNodeTails = OnlyLiterals<PathsUnderPrefix<'shadernetwork.graph.nodes[n].'>>

export const directTail: ShaderNodeTails = 'unit'
export const nestedTail: ShaderNodeTails = 'imageUser.image.width'

// @ts-expect-error no such path under this prefix
export const notATail: ShaderNodeTails = 'unitt'

// An empty prefix leaves the whole catalog, which is what an unprefixed
// container's prop() accepts.
export const unprefixed: OnlyLiterals<PathsUnderPrefix<''>> = 'shadernetwork.name'
