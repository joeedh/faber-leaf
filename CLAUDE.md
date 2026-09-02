# Agent instructions

## Package manager

- Use pnpm

## Plans

- Write all plans to the `documentation/plans` folder (with proper descriptive names; add
  the current date and time to the name).

## Research

- Write all research surveys / write-ups to the `documentation/research` folder (with
  proper descriptive names). Plans still go in the `documentation/plans` folder.

## Setup commands

- Install deps: `pnpm i`
- Install language server: `pnpm install -g @vtsls/language-server typescript && pnpm install -g typescript-language-server && claude -p "/plugin install typescript-lsp@claude-plugins-official"`
- Build: `pnpm build`
- Release build (no source maps; what the Pages CI ships): `pnpm build:release`
  plus `node sculptcore/make.mjs build wasm --release` —
  see [documentation/releaseBuild.md](documentation/releaseBuild.md)
- Typecheck: `pnpm typecheck`
- Start web server: `pnpm serv`

## Generating type annotations

When generating type annotations:

- Do not add annotations if type can be inferred, e.g.
  - Assignment to known typed variables
  - Assignment to new operator
- Do not use the any type
- Do not use single-line control blocks, e.g. `if (test) action()` is bad,
  `if (test) { action() }` is good.
- Do not do dynamic imports, e.g.
  `InputSet extends import('../../path.ux/scripts/pathux.js').PropertySlots = {}` —
  add a proper type import instead.

## Typecheck

Run `npx tsgo --noEmit`, **not** `tsc`. `pnpm typecheck` wraps this and runs
`pnpm gen:paths` first (see [Data API paths](#data-api-paths)).

## Code style

- Read contents of `documentation/codeStyle.md`
- We have a polyfilter for `Set.filter` and `Set.map`.  These are okay to use.
- Do not transform the `Set.filter` to a spread-to-array-then-filter pattern,
  e.g. do not turn `set.filter(n => n.test(0))` into `[...set].filter(n => n.test(0))`
  Also do not transform into a `Array.from` pattern either.
- Typescript strict mode
- Single quotes, no semicolons
- Use `git mv` when renaming files, such as
  changing JS files to TS ones.

## Testing instructions

- Run tests with `pnpm test`
- Run specific test with `pnpm test [test name]`
- Update snapshots with `pnpm test -u`
- Run eslint with `pnpm eslint --fix [path]` it will
  lint code and fix some problems
- The NW.js integration suites are their own workspace package
  (`tests/integration`), run as two sequential jest invocations — one per
  sculptcore backend (`SC_TEST_BACKEND=wasm`, then `native`). Which pass a
  suite belongs to is decided in `tests/integration/split.ts`.
- The wall-clock-dominating suites listed in `tests/integration/slow.mjs` are
  **excluded** from `pnpm test`; run them with `pnpm test:slow` (much less
  often — they're ~90% of the total runtime).

## PR instructions

- Title format: `[<project_name>] <Title>`
- Always run `pnpm test` before committing

## Code Comments

Note: roughly preserve comments written by the user however if they ask you to audit
      or correct comments in a file you may edit the comment to ensure correctness.

- **Doc vs non-doc comments**: a *doc comment* documents the signature it sits
  directly above (a function, method, struct, class, or file) — typically `/** */`
  / `///` / a file-level header. Everything else is a *non-doc comment*: inline or
  block comments inside a function body explaining a specific statement or step.
  The 3-line length limit below applies **only to non-doc comments**.
- **Permanent non-doc comments**: keep short and concise — no more than 3 lines.
  A comment longer than 3 lines is allowed at most once per ~500 lines of a file.
  Permanent comments should not reference the prior state of the code.
- **TODO comments**: may exceed the 3-line limit. Mark especially high-priority
  items with `XXX:`; mark ordinary ones with `TODO:`.
- **Refactor / implementation / temp comments**: no length limit, but prefix them
  with `CLAUDENOTE:` so they can be found and stripped later. The final step of
  any plan is to remove the `CLAUDENOTE:` comments — replacing the ones still
  worth keeping with permanent (≤ 3-line) non-doc comments.
- **Doc comments**: not subject to the 3-line limit, but still keep them short
  and concise; only add them for non-obvious function signatures. A doc comment
  may simply explain how a non-obvious parameter behaves when that is shorter
  than describing the whole function.
- **Approved long non-doc comments**: when a non-doc comment genuinely needs to
  exceed 3 lines (or push a file past its budget), you may ask me to approve it.
  If I approve, add an entry in the form `{path}:{function}:{one-line summary}`
  to the nearest sub-project's approved-comments registry — for sculptcore that
  is `sculptcore/approvedLongComments.md` (see `sculptcore/CLAUDE.md` for the
  C++ style requirement). Entries listed there are exempt from the length limit
  and the per-file budget — do not flag or shorten them in a later comment audit.

## Addons

The builtin editing features (mesh, mesh_edit, curve, subsurf, tetmesh,
sculptcore) live under `addons/builtin/<id>/src/`. See
[documentation/addons.md](documentation/addons.md) for the full authoring guide
(esbuild plugin mechanics, internal vs external ship modes, the mesh
`register_classes.ts` regen). These import/registration rules are always in force:

- Import framework primitives through `@framework/api` (resolves to
  `scripts/framework_api.ts`) — never `../../../../scripts/foo.js`; if a symbol
  is missing from the hub, add it there.
- Import a peer addon through `@addon/<id>/api` (its `src/api.ts` shim).
- Register classes via `api.register(cls)` / `api.registerAll(...)` inside the
  addon's `register(api)` hook — one call dispatches ToolOp / ToolMode /
  DataBlock / CustomDataElem / SceneObjectData / Editor / nstructjs.
- **No** module-scope `*.register(...)` side effects (they bypass the per-addon
  registry and can't be cleanly unregistered). Sole exception:
  `nstructjs.inlineRegister(this, structSrc)` as a static-field initializer.

## Embedding / boot

The app mounts into a container: `mountFaberLeaf(container, options)` in
`scripts/mount.ts`, exported from the bundle entry (`build/entry_point.js`) —
**not** from `@framework/api`. `index.html` and `nwjs/window.html` boot through
that same call, so the shipped app never runs a path an embedder cannot. There
is no `_appstate` global to reach for: `getAppState()` / `peekAppState()` from
`scripts/core/app_instance.ts` return the active instance, and more than one may
be mounted at a time. Host code under `scripts/` must not call
`document.getElementById` / `querySelector` (gated by
`tests/unit/document_scope.test.ts`) — insert through `state.container` and read
the 3D canvas as `state.glCanvas`.

See [documentation/embedding.md](documentation/embedding.md) for the public
contract: what is stable, what a distribution may override, the
`@framework/api` semver policy, and the dated compatibility shims.

## Rendering

The realtime renderer is WebGPU-only. See
[documentation/rendering.md](documentation/rendering.md) for the frame topology
(`NormalPass → AOPass → BasePass → AccumPass ⇄ PassThruPass → SharpenPass.{x,y}
→ OutputPass`), bind-group conventions, how to add post-process / scene-walk
passes, and the attribute-driven WGSL material contract
([documentation/shader-attributes.md](documentation/shader-attributes.md); C++
side in [sculptcore/documentation/spatial.md](sculptcore/documentation/spatial.md)).

## Picking

Viewport picking (click-select, brush/circle/box select, transform snap) is
geometric and addon-owned — no GPU id-buffer. Each object type overrides
`castViewRay` / `findNearest` / `castScreenCircle` / `castScreenRect` on its
`SceneObjectData` subclass; core's `findnearest.ts` is a thin dispatcher that
gates on `selectMask`. See [documentation/picking.md](documentation/picking.md).

## Box modeling

A Blender-style polygon-modeling toolmode for `LiteMesh` objects (selection,
extrude, inset, bevel, split-off, subdivide, loop-cut) alongside sculpt mode.
See [documentation/boxModelingMode.md](documentation/boxModelingMode.md) (design
doc: [documentation/plans/boxModelingTools.md](documentation/plans/boxModelingTools.md)).

## Feature-edge marking (seams & sharp)

Interactive knife-style tools (`litemesh.mark_seam_interactive` /
`mark_sharp_interactive`, hotkeys `K` / `Shift+K`) that flag the source-of-truth
`boundary::EDGE_SEAM` / `EDGE_SHARP` attributes, plus a persistent feature
overlay. See [documentation/feature-marking.md](documentation/feature-marking.md).
How those flags are summarized per-vertex and consumed by the boundary-aware
smooth brushes and dyntopo remesher is the boundary-constraint system:
[sculptcore/documentation/boundaryConstraints.md](sculptcore/documentation/boundaryConstraints.md).

## Node editor

The node-graph editor lives in `scripts/editors/node/`: an abstract CSS-transform
pan/zoom editor (`NodeEditorBase`) whose only registered subclass is
`MaterialEditor` (the Shader Editor), editing a `Graph` by data-API path with all
edits going through the undoable `node.*` ToolOps. See
[documentation/node-editor.md](documentation/node-editor.md).

## Icons

UI icons come from a single hand-authored sheet, `assets/iconsheet.svg` — a
16-column grid of 32×32 cells indexed by the `Icons` map in
`scripts/editors/icon_enum.js` (the `iconsheet*.png` files are generated and
unused). See [documentation/iconsheet-guide.md](documentation/iconsheet-guide.md).

## NW.js test harness / CLI

The desktop shell is **NW.js** (the `nwjs/` workspace; `electron/` was removed).
NW.js merges the Node + browser contexts into one window, so there is **no main
process** — `require`, `process`, `nw.Menu`, `nw.Window`, and file dialogs are
all reachable directly in the renderer. Launch with `pnpm run nwjs`. The **NW.js
app root is the repo root** (its `package.json` is the manifest), because NW.js
serves the app dir as the `chrome-extension://` root and cannot reach files
outside it — so `build/`, `scripts/`, and `assets/` must live under it. Drive a
live app over CDP with the dependency-free `node nwjs/cdp.mjs`
(`list` / `eval "<js>"` / `shot <out.png>`) — use direct CDP, not an MCP server.

The shell also takes CLI flags to boot the real app and build/save/dump/screenshot
deterministic test scenes headlessly (`--gen-scene`, `--eval`, `--run`, `--dump`,
`--backend native|wasm`, `--headless`, `--remote-debug`, `--instance`, …), and
runs multiple instances per-worktree with concurrency-safe `.sculptcore` storage.
See [documentation/native-electron-test-harness.md](documentation/native-electron-test-harness.md)
for the full flag reference and the multi-instance / storage model.

## Debug context API (`CTX.debug`)

`ViewContext.debug` (`scripts/core/context.ts`, class `DebugEditorAPI`) is a
small reflection / test-automation surface on the app context, reachable from any
renderer-JS eval context as `CTX.debug` (`CTX` = `_appstate.ctx`) or as
`ctx.debug` in app code — `listEditorTypes()` / `getIconKey()` / `showEditor(...)`.
For the full window-globals / `CTX` / `CTX.api` / `window.DEBUG` map and how to
drive it over CDP or the headless `--eval` flag (including the active-editor
auto-fill that node-graph ToolOps depend on), see
[documentation/debugSurface.md](documentation/debugSurface.md).

## Native sculptcore backend (N-API)

sculptcore runs from the TS app through two interchangeable backends behind one
`IWasmInterface` (`sculptcore/typescript/api/wasm.ts`): **WASM** (browser) and
**native N-API** (NW.js; C++ reflection runtime in `sculptcore/source/napi/`).
The native path is opt-in (`--backend native`), pointers never cross to JS as
numbers, and there are no zero-copy bulk reads. Build with
`node sculptcore/make.mjs build node [--smoke]`. **Adding a new N-API method is a
4-place change** (`napi_runtime.{h,cc}` → `NativeAddon` type → `NativeManager`
method → `makeNativeInterface`). See
[documentation/native-napi-electron.md](documentation/native-napi-electron.md)
(model + backend seam), [documentation/plans/native-electron.md](documentation/plans/native-electron.md)
(status), and [documentation/debugStrokeGuide.md](documentation/debugStrokeGuide.md)
(writing headless stroke tests).

## Crash reporting (Crashpad)

Native sculptcore (`.node`) C++ crashes are captured as Crashpad minidumps and
symbolicated offline (function + `napi_runtime.cc:line`) via the toolkit
`sculptcore/crash/dump.mjs`. Crashpad is on by default in NW.js; dumps land under
the per-worktree `--user-data-dir` the launcher prints on startup (export
`SC_CRASHDUMP_DIR=<that path>` for the toolkit). Self-test flag is
`--apptest-crash` (not `--crash-test`). See
[documentation/plans/crashpad.md](documentation/plans/crashpad.md).

## Dynamic topology

Geometry under a sculpt dab is subdivided/collapsed on the fly to track a target
edge length, attributes interpolated onto new geometry (sculptcore, CPU-only —
GPU offload is optional). See
[sculptcore/documentation/dynamic-topology.md](sculptcore/documentation/dynamic-topology.md)
and [sculptcore/documentation/plans/dyntopo-m7-cascade.md](sculptcore/documentation/plans/dyntopo-m7-cascade.md).

## Sculpt stroke driver

Sculpt strokes are host-driven: sculptcore owns no camera, spacing, symmetry or
stroke method — it exposes one dab primitive. `BrushStrokeDriver`
(`scripts/editors/view3d/tools/stroke_driver.ts`) turns pointer input into
evenly-spaced samples; `SculptPaintOp` (`sculptcore_ops.ts`) mirrors each sample
and drives the engine. Per-kernel policy (grab discipline, `@unbounded` field,
invert suppression, which attr layers to retarget) is **queried from sculptcore**
via `resolveDabPolicy` in `sculptcore_bindings.ts` — never hardcode a tool-name
conditional; adding a brush should not require a host edit. See
[documentation/strokeDriverReport.md](documentation/strokeDriverReport.md) (TS
architecture) and
[sculptcore/documentation/strokeDriverGuide.md](sculptcore/documentation/strokeDriverGuide.md)
(the engine-facing contract + conformance checklist).

## GPU brushes

When dyntopo is off, the kelvinlet (and, behind soak flag `sculptcore.gpu_brush_grab`,
grab) sculpt brushes dispatch their sbrush WGSL kernels on the renderer's WebGPU
device and scatter deformed positions straight into the node VBOs; the CPU mesh
syncs once at stroke end. Gated on flag `sculptcore.gpu_brush` (default on;
shadow-verify via `sculptcore.gpu_brush_verify`). See
[documentation/gpuBrushes.md](documentation/gpuBrushes.md) (user/dev guide,
troubleshooting, `window.DEBUG.gpuBrush`) and the design plan
[documentation/plans/gpuGlobalBrushes.md](documentation/plans/gpuGlobalBrushes.md).

## Sculpt layers

Re-weightable displacement layers on a LiteMesh (flag `sculptcore.sculpt_layers`,
default off), V2 model: a layer is made the *edit target* (panel toggle →
`litemesh.sculpt_layer_set_target`; weight pinned to 1) and every brush /
dyntopo / GPU stroke then edits it by construction — the delta is derived and
folded on demand (no Layer Draw brush anymore). On a multires level mesh a
layer is a grids-store channel. Weight/enabled/frozen through the undoable
`litemesh.sculpt_layer_*` ToolOps. See
[documentation/sculptLayers.md](documentation/sculptLayers.md).

## Multires subsurf

Multiresolution CC-subdivision sculpting on a LiteMesh (flag `sculptcore.multires`,
default off): the engine owns the grids store + level materialization; the app
attaches one level at a time via undoable `litemesh.multires_*` ToolOps. Adds
Displaced Preview (GPU-amplified finest-level draw) and VDM sculpting (flag
`sculptcore.vdm_sculpt`, default off; Ptex vector-displacement store, undoable
`litemesh.vdm_*` lifecycle + bake ops). Stack and store persist through .wproj.
See [documentation/multires.md](documentation/multires.md).

## Data API paths

See [documentation/datapath-bindings.md](documentation/datapath-bindings.md) for
the binding-system overview (how each class's `static defineAPI` declares props,
how enum/flag icons attach via `.icons(...)`, and how `getDataAPI()` is built).

Valid `path` strings for `container.prop("...")` (and `slider`, `check`, etc.)
are catalogued by walking `getDataAPI()`. After editing `api_define.ts` (or any
class's `defineAPI`), run `pnpm gen:paths` to regenerate
`scripts/data_api/generated/` — `API_PATHS.md` is the human/LLM path reference,
`api-paths.json` the machine-readable catalog, and `datapaths.ts` the committed
`KnownDataPath` autocomplete augmentation. `pnpm typecheck` runs `gen:paths`
first (`pnpm build` does not).

## Feature flags

Runtime boolean knobs for opt-in / experimental features, persisted in
`localStorage` and wired into the Data API. See
[documentation/featureFlags.md](documentation/featureFlags.md) for usage,
how to add a flag, and persistence semantics.

## Cross-layer follow-ups

Layer violations are machine-checked, not listed in prose: `pnpm check:layers`
cruises `scripts` + `addons` with `.dependency-cruiser.cjs` and fails on any
`error`-severity rule or any count over its `tools/layer-baseline.json` budget.
A host file importing addon source, or an addon importing a peer through a
`scripts/...` path instead of `@addon/<id>/api`, is caught there. Lower a
budget when you remove edges; never raise one to make the gate pass.

(The old free-text `TODO.md` this section used to point at was deleted in
`6af17e06`; the gate replaced it.)

## Submodules

- Keep submodules checked out at the HEADs of their current branches, pulling and
  merging as needed — **except** `sculptcore/extern/imgui`, which stays pinned at
  its recorded commit (third-party, version-locked). (`sculptcore/emsdk` is no
  longer a submodule — it is git-cloned and pinned by `make.mjs install-emsdk`
  and is gitignored.)
- The `master` branch must always link submodules at their default-branch commits
  (never pin `master`'s gitlinks to a submodule feature branch).
- **Commit a parent repo and its submodules together** whenever their branch names
  match, or both are on their default branches: make the submodule commit, then
  bump the parent's gitlink, as one logical change. The pinned exception
  (`sculptcore/extern/imgui`) is excluded — bump it deliberately, never as part
  of a co-commit.
- **Parent on a branch, submodule on its default branch:** do not silently commit
  or advance the submodule's shared default branch. Ask the user whether they want
  to commit and/or push the submodule's default branch (and bump the gitlink)
  before doing so.
- **Worktree teardown:** before removing a worktree, every submodule sitting on its
  default branch — except the pinned `sculptcore/extern/imgui` — must be committed
  and pushed, so no work is lost when the checkout goes away.

## Secondary-agent worktree

A persistent git worktree for secondary/parallel agentic work lives at
`C:/dev/webgl-app-framework-agent` (a sibling of this repo; it is not nested
inside it). Use it to run a second agent without disturbing the primary
checkout. Conventions:

- **Idle state = detached at `master`.** `master` is checked out in the main
  worktree, and git forbids the same branch in two worktrees, so the agent
  worktree cannot hold a normal `master` checkout. When not in use it sits in
  **detached HEAD at `master`'s commit**; its submodules sit at their pinned
  (recorded) commits. Leave it this way when you finish.
- **When starting work, switch to a new branch** in the worktree:
  `git -C C:/dev/webgl-app-framework-agent switch -c <branch>`.
- **Only commit submodules you actually modified onto a new branch** — leave
  untouched submodules detached at their pinned commits. Inside a modified
  submodule: `git switch -c <branch>` before committing there, then bump the
  gitlink in the superproject branch.
- **When done, return to idle:** commit/stash or discard your work, then
  `git -C C:/dev/webgl-app-framework-agent checkout --detach master` and
  re-sync submodules (`git submodule update --init --recursive`).
  (`checkout master` will fail — it's held by the main worktree; always use
  `--detach master`.)
- **Submodules populate only from their remotes** (no cross-worktree local-fetch
  of unpushed pinned commits — that recovery path was removed). So
  `git submodule update --init --recursive` requires every pinned submodule
  commit to be reachable from its remote; it fails on local-only commits with
  `Fetched in submodule path '<X>', but it did not contain <sha>`. Two fixes,
  mirroring `new-worktree.mjs`'s `--submodules` modes:
  - **require-pushed** — push the missing submodule commit(s) to their remote
    (`git -C <main-or-other-worktree>/<sub> push origin <branch>`), then re-run
    the recursive update so the worktree matches the recorded pins exactly.
  - **remote-master** — ignore the pins and branch each submodule from its remote
    master tip: `git submodule update --init --recursive --remote`, then
    `git submodule foreach --recursive 'git switch -c <branch>'`. Use this when
    submodule work is local-only/unpushed or you want to start from the latest
    remote.


## Prose
<!-- commentlint-off -->

These rules govern every piece of prose in the repository. They apply to code comments, to
this file, and to everything under `documentation/`.

- **Write plain declarative prose — no epigrams.** State the constraint or decision
  directly: "An empty answer is deliberate and is passed to the model as-is", not "Empty is an
  answer — silence, said out loud." If a sentence needs a second read to parse, rewrite it.
  Specific patterns to catch:
  - **Inverted syntax and personification** — the sentence performs rather than informs.
  - **Metaphorical equations** — "The leak scan is the refusal", "what ships is identity",
    "the project as commands". The connector word varies — do not get hung up on "is"
    versus "as". Say what happens instead: "Refuses if the leak scan finds a known name
    still in the body."
  - **Fragment openers that defer the subject — never use this pattern.** Naming a placeholder
    and then withholding the real content behind a colon or a dash is always wrong: "The
    redactor to scan a report with: the one that wrote it, else one built from the project as it
    stands." Lead with a complete sentence and name each case as you reach it. A doc comment is
    not an exception, and deleting the label is not the fix, because the apposition left behind
    is still headless. Supply a predicate instead. Write "Draws the links beneath the node
    frames in screen space." rather than "The link underlay: a screen-space canvas beneath the
    node frames." or the bare "Screen-space canvas beneath the node frames."
  - **Double negatives** — "the palette cannot be relied on not to". State the positive claim.
  - **Pronouns and ellipses that point outside the sentence** — "the second case", "asking
    twice is how…" — each sentence should carry its own referents.
  - **"Clause A, else B" constructions** — "Resolve a push's destination: the named window
    when it still exists, else the focused window falling back to the most recently focused
    one." Spell out the cases as ordinary sentences instead: "Pushes to the named window if it
    still exists. Otherwise pushes to the focused window, or the most recently focused window
    if none is focused."
  - **Adverbs hung off the end of a noun phrase** — "the next pointerdown anywhere", "the
    handler above". The adverb postmodifies the noun, but the reader cannot tell on first pass
    whether it attaches to the noun or to the clause's verb, and an event or API name coined
    from a verb ("pointerdown") re-parses as a clause when an adverb follows it. Attach the
    qualification to a verb, or state it as its own fact: "the listener is on `window`".
  - **Non-assertive words under a definite** — "any", "anywhere", "ever" range over
    alternatives, so they fight a definite description that names exactly one thing. "A press
    anywhere dismisses it" reads fine; "the next pointerdown anywhere" does not.
  - **Rhetorical emphasis** — bold and italics inside a sentence mark the clause the author
    found most interesting, not the one the reader needs first. Put the load-bearing claim in
    the first sentence and drop the markup. A bolded lead-in that labels a Markdown bullet is
    structure rather than emphasis, and is fine.
  - **A head noun that is not what the thing is** — a module of commands documented as "The
    prompt an asset is generated from, as commands" asserts that the module is a prompt, then
    retracts it through a preposition. Lead with the head noun that names the thing —
    "Commands for the prompt an asset is generated from" — and demote the rest to a
    complement. A trailing ", as X" or ", in the form of X" is the same metaphorical equation
    above smuggled in through an adjunct.
- **Reserve backticks for code symbols.** Backticks belong on identifiers, types, commands,
  and file globs the reader will type. A file path cited mid-sentence as a reference —
  documentation/NodeEditor.md §3 — takes none, because marking it up gives it the same weight
  as the identifiers around it and dilutes them. Markdown link text is the one exception and
  keeps its backticks, where the marking separates a path from the prose around it rather than
  competing with nearby identifiers.
- **Bracket a subordinate alternative rather than fencing it with commas.** Parentheses mark the
  material as skippable, so the reader gets a complete sentence either way; paired commas leave
  it unclear whether the second comma closes an interpolation or opens a new clause. Write
  "Dropping onto itself (or onto a neighbor it would split against) is not a rip". Drop any comma
  that would follow the closing bracket — it separates the subject from its verb.

- **DO NOT INVOKE ESLINT DIRECTLY** use tools/eslint.mts
  - use node to execute it directly, if it's new enough it'll
   parse the type annotations.
  - otherwise use tsx
<!-- commentlint-on -->

