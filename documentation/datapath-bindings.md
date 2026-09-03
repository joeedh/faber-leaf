# Data API path bindings — index

The app binds UI widgets to model state through **data paths**: string paths
like `mesh.symFlag` or `scene.tools.brush.tool` passed to `container.prop(...)`
(and `slider`, `check`, `checkenum`, `listenum`, `pathlabel`, `textbox`, plus
`<prop path="...">` xmlpage tags). This file is the entry point for resolving
those paths.

## The authoritative path catalog

The full, generated catalog of every valid path lives in
[`scripts/data_api/generated/`](../scripts/data_api/generated/):

- **`API_PATHS.md`** — human/LLM-readable table: every path, its kind
  (`struct` / `prop` / `list`), property type, UI name, range, unit, and enum
  items. **Read this first** to resolve a path or find the path for a property.
- **`api-paths.json`** — the same catalog, machine-readable. The
  `pathux/valid-datapath` ESLint rule reads a copy of it.

Paths are checked by that ESLint rule alone. path.ux can also emit the catalog
as a `KnownDataPath` string-literal union that types `prop()`'s argument, and
this app does not: a catalog this size made the union expensive enough to hit
`TS2859: Excessive complexity` inside `PathsUnderPrefix`, and dropping it took
`scripts`' typecheck from 19s to 3s. `prop()` takes a plain `string` here.
A container built with a prefix still declares it through
`withDataPrefix<'...'>()`, which is how the rule resolves prefix + path exactly
rather than accepting any path with a matching tail.

These are **auto-generated** by walking `getDataAPI()`. Don't hand-edit them —
edit [`scripts/data_api/api_define.ts`](../scripts/data_api/api_define.ts) (the
definitions — or the owning class's `static defineAPI`) and run `pnpm gen:paths`
to regenerate. `pnpm typecheck` runs `gen:paths` first so the catalog never goes
stale.

## How bindings are declared

Bindings are declared per class in a `static defineAPI(api, struct?)` method
against the class's `DataStruct`:

```ts
static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
  let mstruct = struct ?? api.mapStruct(this, true)
  mstruct.float('radius', 'radius', 'Radius').range(0.1, 350.0)   // float prop
  mstruct.flags('symFlag', 'symFlag', MeshSymFlags, 'Symmetry')    // bitflag enum
         .icons({ X: Icons.SYM_X, Y: Icons.SYM_Y, Z: Icons.SYM_Z })
  return mstruct
}
```

The chain `struct.float/int/enum/flags/string/vec3/...('apiname', 'propname',
'uiname')` registers a property; the `apiname` segment is what appears in the
path. Widgets then resolve `container.prop('mesh.symFlag')` against this tree.
`getDataAPI()` (`scripts/data_api/api_define.ts`) calls each registered class's
`defineAPI` by iterating `dataAPIRegistry`; register a new class with
`registerDataAPI(cls)`. Subclasses chain `super.defineAPI(api, struct)` onto
their own struct. See the
[`defineAPI` refactor plan](plans/api-define-defineapi-refactor.md).

## How `getDataAPI()` is built (build/ordering)

Subclasses **chain** their parent (`super.defineAPI(api, struct)` re-declares the
parent's members onto the child's own struct) rather than copying an
already-built parent struct, so registry-class population is
**order-independent** — no class needs another to be defined first. Register a
new class with `registerDataAPI(cls)` in any order.

`getDataAPI()` runs in two passes:

1. **Population pass** — non-class pre-steps (sockets / matrix4 / customdata) →
   `registerCoreDataAPIClasses()` → a `defineOnce` loop over `dataAPIRegistry` →
   class-dependent helpers that chain `DataBlock.defineAPI`.
2. **Attach pass** — explicitly wires the populated structs into the
   `ToolContext` tree.

The only build-first requirement is the non-class pre-pass structs (`Graph`,
`VelPan`) that a few `defineAPI`s fetch by reference via `api.getStruct(...)`;
the population pre-pass builds them ahead of the registry loop. The on-disk
catalog is **canonically sorted** (lexicographic by normalized path in
`tools/gen-datapaths.mjs`), so the committed `generated/` files are stable
regardless of population / traversal order.

The `pathux/valid-datapath` ESLint rule (warn) flags `prop(...)` strings not in
the catalog; dynamically-indexed paths (e.g. `flag[ENUMNAME]`) warn because the
walker can't enumerate them — those are expected and harmless.

## Containers built under a path prefix

A `buildUI(container)` hook is handed a container whose `dataPrefix` is already
set, so its paths are relative — `container.prop('unit')` resolves to
`shadernetwork.graph.nodes[n].unit`. Nothing in that call says so, which leaves
the linter matching `unit` against every path ending in `.unit`. Declare the
prefix instead:

```ts
type DataPrefix = 'shadernetwork.graph.nodes[n].'

buildUI(container: Container): void {
  const con = container.withDataPrefix<DataPrefix>()
  con.prop('unit')
}
```

`withDataPrefix` only re-types the container (whoever built it already set the
runtime prefix). From there `prop` autocompletes the paths under the prefix, and
the ESLint rule reads the prefix off the receiver's type and checks the joined
path exactly, so a typo reports as
`Unknown data path "shadernetwork.graph.nodes[n].unitt"` with the real tails
listed. `scripts/shadernodes/shader_nodes.ts` is the worked example, and
`scripts/data_api/datapath_prefix_types.ts` fails the typecheck if the
prefix-to-tails resolution regresses.

Full write-up: path.ux
[`documentation/container.md`](../scripts/path.ux/documentation/container.md)
§ Path prefixes.

## How icons attach to bindings

Icons are bound to **enum and bitflag properties**, one icon per enum key:

- `enumProp.icons({ KEY: Icons.NAME, ... })` / `flagsProp.icons({ ... })` in
  `api_define.ts` (see the `.icons(...)` call sites — e.g. `selectMask`,
  `symFlag`, brush `tool`/`flag`, `lib_flag`).
- Under the hood this stores an `iconmap` (`{enumKey: numericIndex}`) on the
  property (`addIcons` in
  `scripts/path.ux/scripts/path-controller/toolsys/toolprop.ts`).
- The numeric index is `Icons.NAME` from
  [`scripts/editors/icon_enum.js`](../scripts/editors/icon_enum.js), i.e. the
  row-major cell index into `assets/iconsheet.svg`
  (see [iconsheet-guide.md](iconsheet-guide.md)).
- `checkenum` / `listenum` widgets and enum menus read the `iconmap` to draw the
  icon next to each enum value; a plain `prop`/icon-button uses
  `Icons.NAME` directly.

So the chain for an icon shown in the UI is:

```
assets/iconsheet.svg cell  ──(row-major index)──▶  Icons.NAME (icon_enum.js)
   ──▶  .icons({KEY: Icons.NAME}) in api_define.ts  ──▶  enum/flag property iconmap
   ──▶  checkenum/listenum bound via prop('<path>')  ──▶  rendered glyph
```

To find which bindings reference an icon, grep `api_define.ts` for
`Icons.NAME`; to find which path drives a widget, look it up in `API_PATHS.md`.

## See also

- [iconsheet-guide.md](iconsheet-guide.md) — authoring the icons themselves.
- path.ux controller docs:
  [`scripts/path.ux/documentation/controller.md`](../scripts/path.ux/documentation/controller.md).
