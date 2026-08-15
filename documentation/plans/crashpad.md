# Crashpad crash reporting for the NW.js app

## Status — IMPLEMENTED & VERIFIED (2026-06-21)

End-to-end working: a native C++ crash in sculptcore is captured by Crashpad and
symbolicated by the toolkit to **function + source file:line**. Verified walk of
a real native crash:

```
Access violation - code c0000005
sculptcore_node!sculptcore::napi::NapiRuntime::CrashTest+0x4
   [C:\dev\webgl-app-framework\sculptcore\source\napi\napi_runtime.cc @ 2051]
 ← node!napi... ← nw!v8::Function::Call
```

Two findings corrected the original plan during implementation:

1. **NW.js 0.112 has no `nw.App.setCrashDumpDir`** (the documented API is stale —
   confirmed by introspecting the live `nw.App`). There is **no way to redirect
   the dir**, so dumps land in the Chromium default
   `%LOCALAPPDATA%\<manifest-name>\User Data\Crashpad\reports\*.dmp`
   (`<manifest-name>` = `faber-leaf`). The toolkit reads from there;
   `$SC_CRASHDUMP_DIR` overrides. Crashpad itself **is on by default** — no
   enabling needed.

   > **Per-worktree dump dir (current path).** Crashpad writes under the active
   > `--user-data-dir`, which `nwjs/launch.mjs` now sets **per-worktree** (see the
   > NW.js multi-instance model), so dumps actually land in
   > `%LOCALAPPDATA%\faber-leaf\worktrees\<dir>-<hash8>\<profile>\Crashpad\reports\*.dmp`
   > (that base dir was `webgl-app-framework` before the Faber Leaf rename, so
   > pre-rename dumps stay at the old path) — **not** the
   > old `User Data\…` path that `dump.mjs` still defaults to. The launcher
   > **prints** the exact reports dir on startup; export
   > `SC_CRASHDUMP_DIR=<that path>` before running `sculptcore/crash/dump.mjs`
   > (its first-choice override) so the toolkit reads the right dir. The toolkit
   > wraps the Windows SDK `cdb.exe` at
   > `C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe`.
2. **`--crash-test` is a real Chromium switch** NW.js intercepts (it breakpoints
   the browser process at startup, exactly like `--headless`). The self-test flag
   is therefore **`--apptest-crash`** (the established `--apptest-` prefix
   pattern), wired in `test_harness.ts`.

What shipped:
- CodeView PDB for the addon (`sculptcore/CMakeLists.txt`, clang `-gcodeview` +
  `/DEBUG` + `/PDB`), auto-archived per-build into the content-addressed store
  `build/crashdumps/syms/<pdb>/<GUID>/` (`make.mjs` `buildNodeAddon` →
  `archivePdb` in the toolkit).
- Crash-dump toolkit `sculptcore/crash/dump.mjs`
  (`list/walk/info/threads/open/eval/package/symcheck/prune`, `--json`,
  `--public-syms`); PE/RSDS parser produces the symstore key.
- JS crash-net in `nwjs/window.html` (`error`/`unhandledrejection`/
  `uncaughtException` → `console.error`).
- Crashpad self-test: native `crashTest()` export (`napi_runtime.cc`) driven by
  the harness `--apptest-crash` flag (builds the litemesh scene to load the
  addon, then null-derefs in native code).

Everything below is the original plan, kept for rationale; where it says
`setCrashDumpDir` / `build/crashdumps` (as the dump dir) / `--crash-test`, read
the corrections above.

## Context

When the native **sculptcore** N-API addon crashes (a C++ segfault / bad deref
during sculpt/dyntopo/remesh), the whole NW.js renderer process dies with no
trace. The renderer's stderr is already dead in NW.js (CLAUDE.md notes the EBADF
issue; logging is routed to the DevTools console via `sc_napi` sinks), so a hard
native crash leaves nothing actionable. We want **Crashpad minidumps** of those
crashes so we can symbolicate the C++ call stack offline.

Key facts established during investigation:

- NW.js `0.112.0-sdk`, Windows x64. The SDK ships **no standalone
  `crashpad_handler.exe`** — on Windows modern Chromium/NW.js *embeds* the
  handler in the main binary and spawns it as `nw.exe --type=crashpad-handler`.
  So Crashpad is present; it just needs enabling + a dump dir.
- App root = repo root; `main: nwjs/window.html`; the `.node` addon runs
  **in the renderer process** (NW.js merges Node+browser, no separate main
  process), so a renderer minidump captures the C++ frames.
- Native addon builds via cmake-js + the repo clang toolchain
  (`sculptcore/build_files/native-clang.cmake`), `CMAKE_BUILD_TYPE`
  default `RelWithDebInfo`. Output: `build/native-node/sculptcore_node.node`.
  **No PDB is emitted today** — symbolication will fail without one.

**Decisions (from user):** local-only minidumps (manual symbolication with
cdb/WinDbg); carry symbols via **clang + CodeView PDB** (stay on the clang
toolchain, do not switch to the MSVC path).

## Approach

Three layers, smallest-blast-radius first.

### 1. Enable Crashpad + pick a dump dir (NW.js)

In the `nwjs/window.html` bootstrap (the renderer entry, before
`import('../build/entry_point.js')`), call NW.js's crash-dump API early:

```js
if (globalThis.nw) {
  // dump dir under the repo build/ tree, stable + gitignored
  nw.App.setCrashDumpDir(/* <repo>/build/crashdumps */);
}
```

- Resolve the dir relative to the app root (repo root) using `nw.App.startPath`
  / `process.cwd()` + `require('path')`, and `fs.mkdirSync(dir,{recursive:true})`.
  The docs explicitly warn the dir must already exist or no dump is written, so
  the `mkdirSync` is load-bearing, not defensive.
- Minidumps land as `*.dmp`. Add `build/crashdumps/` to `.gitignore`.

**API surface — verified** against the official NW.js crash-dump docs (signatures
confirmed, not assumed):

- `nw.App.setCrashDumpDir(dir)` — sets the minidump output dir. Equivalent to
  `require('nw.gui').App.setCrashDumpDir(dir)` (`nw.App` *is* `gui.App`). Must be
  called **before** the crash; a crash before it runs writes to the default
  location instead — so call it in the earliest bootstrap, before
  `import('../build/entry_point.js')`.
- Test triggers `nw.App.crashRenderer()` / `nw.App.crashBrowser()` (since
  NW.js 0.8.0) — the renderer one is what we want (the `.node` runs in the
  renderer).
- **Default location if we don't override** (Windows, modern Chromium/NW.js):
  `%LOCALAPPDATA%\<name-in-manifest>\User Data\CrashPad` (older builds used the
  system temp dir). Our `setCrashDumpDir` redirects this to `build/crashdumps/`.

**Risk to watch:** several NW.js issues (#2906, #3226, #3831) report *no dump
file generated* on Windows under modern Chromium even with the dir set — the
embedded Crashpad handler sometimes keeps writing to `User Data\CrashPad` and
ignores `setCrashDumpDir`. So the **first** implementation step is the smoke
test (Verification §2): set the dir, call `crashRenderer()`, confirm a `.dmp`
actually lands in `build/crashdumps/`. If it doesn't, fall back to pointing the
toolkit (§4) at the real `User Data\CrashPad` dir instead of fighting the API.

Critical file: `nwjs/window.html` (and `.gitignore`).

### 2. Make the native addon symbolizable (clang → CodeView PDB)

A minidump is useless without a matching PDB. Add CodeView debug-info emission +
a linked PDB to the **node-addon** build only (don't disturb `build/native`):

- Compile flags: `-g -gcodeview` (clang emits CodeView in the objects when
  targeting the MSVC ABI).
- Link flags: pass `/DEBUG` (and an explicit `/PDB:sculptcore_node.pdb`) through
  to the linker so a PDB is produced next to the `.node`.

Where to wire it: the node-addon target is gated on `DEFINED CMAKE_JS_VERSION`
in the **root `CMakeLists.txt`**, built with the clang toolchain
(`sculptcore/build_files/native-clang.cmake`) and configured by
`configureNodeAddon()` / `buildNodeAddon()` in `sculptcore/make.mjs`. Add the
flags scoped to that target (prefer a CMake `target_compile_options` /
`target_link_options` guarded by `CMAKE_JS_VERSION` + `WIN32`, so the WASM and
plain-native trees are untouched). Archive `sculptcore_node.pdb` alongside the
`.node` so dumps stay walkable after rebuilds.

Critical files: root `CMakeLists.txt` (node-addon target block);
possibly `sculptcore/make.mjs` (if flags are easier injected via cmake-js
`--CD...` args).

### 3. JS-layer crash net (non-fatal errors)

Crashpad only fires on hard process crashes. Add an early handler block (same
bootstrap, or `scripts/core/app_argv.ts` / entry init) for JS-level failures so
they share one stream with native logs:

- `window.onerror`, `window.addEventListener('unhandledrejection', …)`,
  and `process.on('uncaughtException', …)` (Node side is reachable in NW.js).
- Route through the existing `sc_napi` console sink path so JS + native logs
  interleave in DevTools.

### 4. Crash-dump toolkit — analyze & manipulate (`sculptcore/crash/dump.mjs`)

A minidump on disk is inert; the value is in being able to walk, inspect, and
manage them with **one ergonomic CLI** instead of remembering raw `cdb` flags.
Build a single dependency-free Node script, `sculptcore/crash/dump.mjs`, that
wraps the Windows SDK debugger (`cdb.exe`) and the local build artifacts. It is
the "easy way" the rest of the workflow leans on.

**Symbol-path resolution (shared by every subcommand).** A `resolveSymPath()`
helper builds the `-y` path once: the archived `build/native-node/` dir (holds
`sculptcore_node.pdb`), the latest *packaged* PDB for older dumps (see
`package` below), and optionally `srv*<cache>*https://msdl.microsoft.com/...`
for system DLLs (gated behind `--public-syms`, off by default for offline use).
A `findCdb()` helper locates `cdb.exe` under the Windows SDK
(`C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\`) and prints an install
hint if absent rather than throwing.

**Subcommands** (each takes a dump path or, if omitted, the newest dump in
`build/crashdumps/`):

- `list` — table of dumps in `build/crashdumps/`: filename, mtime, size, and a
  cached one-line top-of-stack summary (the faulting frame). Newest first.
- `walk [dump]` — symbolicated stack of the **faulting thread**
  (`cdb -z <dump> -y <syms> -c ".lines; kn; q"`). The default everyday command.
- `info [dump]` — exception record (code + address), faulting module, register
  dump, and a **PDB-match check** for `sculptcore_node` (GUID/age vs the on-disk
  PDB) so a silent symbol mismatch is caught immediately.
- `threads [dump]` — all thread stacks (`~*kn`) for deadlock / cross-thread
  crashes.
- `open [dump]` — launch the dump **interactively** in WinDbg (or `cdb`) with the
  symbol path already wired, for hands-on poking (`dx`, `dt`, memory reads).
- `eval [dump] "<cdb cmds>"` — escape hatch: run an arbitrary `cdb` command
  string against the dump (this is the "manipulate" primitive — anything the
  fixed subcommands don't cover).
- `package [dump]` — zip the dump **plus the matching `sculptcore_node.pdb`**
  plus a small `build-info.json` (git SHA, NW.js version, build type) into
  `build/crashdumps/<name>.zip`. This is what makes a dump survive a rebuild and
  what you hand to someone else — without the contemporaneous PDB an old dump is
  unsymbolizable.
- `symcheck [dump]` — standalone GUID/age verification; exits non-zero on
  mismatch so it can gate CI / scripts.
- `prune [--keep N]` — delete all but the newest N dumps (and their `.zip`s).

**Scriptability.** Every read subcommand accepts `--json` and emits a structured
record (exception, top frames as `{module, symbol, file, line}`, module list,
pdb-match bool) instead of raw `cdb` text, so dumps can be triaged
programmatically (e.g. bucketing crashes by faulting function). `walk`/`info`
parse `cdb`'s output into that shape; the raw text stays available without
`--json`.

**PDB archival hook.** For `package` and old-dump symbolication to work, each
addon build must keep its PDB. Have `buildNodeAddon()` in `make.mjs` copy
`sculptcore_node.pdb` into a content-addressed store
(`build/crashdumps/syms/<pdb-guid>/`) after a successful build; `resolveSymPath`
adds that store to `-y`. Cheap, and it decouples "which PDB matches this dump"
from "what's currently built".

Critical files: new `sculptcore/crash/dump.mjs`; `sculptcore/make.mjs`
(`buildNodeAddon` PDB-archival step); `.gitignore` (`build/crashdumps/`).

### 5. (Optional, defer) C++ breadcrumb

Crashpad already installs the OS exception handler, so no custom handler is
required. A thin `std::set_terminate` / SEH breadcrumb in
`sculptcore/source/napi/napi_entry.cc` that logs "crashing in sculptcore" via
the console sink before Crashpad takes over is a nice-to-have — skip in v1.

## Verification (end-to-end)

1. Build the addon with the new flags: `node sculptcore/make.mjs build node`,
   confirm `build/native-node/sculptcore_node.pdb` exists.
2. Launch: `pnpm run nwjs` (native backend). Add a temporary harness flag
   `--crash-test` (parse in `scripts/core/test_harness.ts`) that calls
   `nw.App.crashRenderer()` after boot — confirm a `*.dmp` appears in
   `build/crashdumps/`.
3. Symbolicate via the toolkit: `node sculptcore/crash/dump.mjs list` then
   `node sculptcore/crash/dump.mjs walk` (newest dump) and confirm sculptcore
   C++ frames resolve to function names + source lines. Run
   `node sculptcore/crash/dump.mjs info` and confirm the `sculptcore_node`
   PDB-match check passes (GUID/age match). Exercise `package` and re-`walk` the
   archived copy to prove an old dump stays symbolizable after a rebuild.
4. Trigger a *real* native crash via a known-bad path (or temporarily inject a
   null-deref behind a flag) and confirm the stack points into the right
   sculptcore function.
5. Remove the temporary `--crash-test` / injected-crash scaffolding.

## Out of scope (this pass)

- Remote/server upload of crashes (chose local-only).
- breakpad `.sym` generation / cross-platform symbol server.
- MSVC-toolchain symbols (chose clang+CodeView).
