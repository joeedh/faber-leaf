/**
 * Generate the app's data-path catalog + compile-time typo-check artifacts.
 *
 * This is a thin wrapper around path.ux's generator: it reuses the submodule's
 * API walker (`walkAPI`/`normalizePath`) and renderers (`renderJSON`,
 * `renderMarkdown`, `renderDts`), but supplies its own esbuild bundle step so
 * our `scripts/data_api/api_define.ts` (which transitively imports addon source
 * using `@framework/*` and `@addon/<id>/api`) actually resolves and loads under
 * node. The stock CLI (`scripts/path.ux/buildtools/gen-datapaths.mjs`) bundles
 * with no alias map and so can't load our API.
 *
 * Outputs:
 *   scripts/data_api/generated/api-paths.json   machine-readable catalog
 *   scripts/data_api/generated/API_PATHS.md      human/LLM reference
 *   scripts/data_api/generated/datapaths.ts      KnownDataPath union (typo check)
 *   scripts/path.ux/generated/api-paths.json     copy for the ESLint rule, whose
 *                                                catalog path is hardcoded there
 *
 * Usage: node tools/gen-datapaths.mjs
 */
import {readFile, writeFile, mkdir, rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve, dirname} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {walkAPI, normalizePath} from '../scripts/path.ux/buildtools/datapath-walker.mjs'
import {renderJSON, renderMarkdown, renderDts} from '../scripts/path.ux/buildtools/gen-datapaths.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const EXPORT_NAME = 'getDataAPI'
// Roots the import graph at scripts/_framework_runtime.js (whose first import is
// the @framework/api barrel) exactly like scripts/entry_point.js does. This is
// what orders CustomDataElem (customdata.ts) ahead of its subclasses in
// mesh_customdata.ts; rooting the graph anywhere else breaks the
// customdata→barrel→mesh_customdata cycle the other way and hits a
// "Class extends undefined" TDZ. Co-located with api_define.js so these
// relative specifiers resolve identically.
// P13 deleted the builtin_data_api bridge along with the BREP addon it fed, so
// there is nothing addon-owned left to pull in here: the generator never boots
// addons, and every surviving builtin contributes its data API through the
// per-addon lifecycle instead.
const GEN_ENTRY_SRC = `import '../_framework_runtime.js'
export {${EXPORT_NAME}} from './api_define.js'
`
const OUT_DIR = resolve(REPO_ROOT, 'scripts/data_api/generated')
// path.ux's eslint rule hardcodes resolve(__dirname, "../../generated/api-paths.json").
const ESLINT_CATALOG = resolve(REPO_ROOT, 'scripts/path.ux/generated/api-paths.json')
// renderDts() augments `declare module <this>`; must resolve to the module that
// re-exports path.ux's DataPathRegistry (tsconfig maps @framework/pathux→pathux.ts).
const AUGMENT_MODULE = '@framework/pathux'

// DOM / browser-global stub so the app's module-scope code can evaluate under
// node. Adapted from scripts/path.ux/buildtools/gen-datapaths.mjs with extra
// WebGL / canvas / worker stubs our renderer-heavy modules touch at load time.
const DOM_STUB_BANNER = `
{
  const noop = () => {};
  const elTarget = { style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, dataset: {}, children: [], childNodes: [] };
  const el = new Proxy(elTarget, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
  const win = globalThis;
  for (const k of ["addEventListener", "removeEventListener", "dispatchEvent", "requestAnimationFrame", "cancelAnimationFrame", "scrollTo"]) {
    if (typeof win[k] !== "function") win[k] = noop;
  }
  win.window ||= win;
  win.requestAnimationFrame ||= (cb) => 0;
  win.matchMedia ||= () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
  win.getComputedStyle ||= () => new Proxy({}, { get: () => "" });
  win.devicePixelRatio ||= 1;
  win.location ||= { href: "about:blank", pathname: "/", search: "", hash: "", protocol: "about:", host: "", hostname: "", port: "", origin: "about:blank", reload: noop, assign: noop, replace: noop };
  const storage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 };
  win.localStorage ||= storage;
  win.sessionStorage ||= storage;
  globalThis.navigator ||= { userAgent: "node", platform: "node", maxTouchPoints: 0 };
  globalThis.Worker ||= class { constructor() {} postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} };
  globalThis.OffscreenCanvas ||= class { constructor() {} getContext() { return null; } };
  // Classes referenced as base classes / instanceof at module-eval time.
  for (const name of [
    "HTMLElement", "Element", "Node", "EventTarget", "Event", "UIEvent",
    "MouseEvent", "PointerEvent", "KeyboardEvent", "TouchEvent", "DragEvent",
    "WheelEvent", "FocusEvent", "InputEvent", "CustomEvent", "Image",
    "HTMLCanvasElement", "HTMLDivElement", "HTMLInputElement", "DOMParser",
    "HTMLImageElement", "HTMLVideoElement", "HTMLAnchorElement", "HTMLBodyElement",
    "ResizeObserver", "MutationObserver", "IntersectionObserver",
    "WebGLRenderingContext", "WebGL2RenderingContext", "WebGLTexture",
    "WebGLFramebuffer", "WebGLBuffer", "WebGLProgram", "WebGLShader",
    "ImageData", "Path2D", "FileReader", "Blob",
  ]) {
    if (typeof globalThis[name] === "undefined") {
      globalThis[name] = class {};
    }
  }
  if (!globalThis.HTMLElement) { globalThis.HTMLElement = class HTMLElement {}; }
  if (!globalThis.customElements) {
    globalThis.customElements = { define: noop, get: noop, whenDefined: () => Promise.resolve() };
  }
  // Canvas 2d/webgl contexts return a permissive proxy rather than null so
  // code that grabs a context at module scope doesn't crash.
  const ctxProxy = new Proxy({}, { get: () => () => ctxProxy });
  if (globalThis.HTMLCanvasElement && !globalThis.HTMLCanvasElement.prototype.getContext) {
    globalThis.HTMLCanvasElement.prototype.getContext = () => ctxProxy;
  }
  if (!globalThis.document) {
    globalThis.document = new Proxy(
      {
        createElement: () => el,
        createElementNS: () => el,
        createTextNode: () => el,
        body: el,
        head: el,
        documentElement: el,
        addEventListener: noop,
        removeEventListener: noop,
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
      },
      { get: (t, k) => (k in t ? t[k] : noop) }
    );
  }
}
`

/** Tolerant parse of tsconfig.json (jsonc: // comments + trailing commas). */
function parseJsonc(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(noTrailingCommas)
}

/** esbuild alias map from tsconfig.json `paths` (each value is a 1-elem array). */
async function aliasFromTsconfig() {
  const raw = await readFile(resolve(REPO_ROOT, 'tsconfig.json'), 'utf8')
  const tsconfig = parseJsonc(raw)
  const paths = tsconfig.compilerOptions?.paths ?? {}
  const alias = {}
  for (const [key, targets] of Object.entries(paths)) {
    if (Array.isArray(targets) && targets[0]) {
      alias[key] = resolve(REPO_ROOT, targets[0])
    }
  }
  return alias
}

// Optional deps reachable in the import graph (docbrowser → marked, electron
// platform → electron, config → the gitignored per-machine config_local.js)
// that aren't installed/needed to assemble the DataAPI. Resolve them to a
// permissive proxy so any named import is a harmless no-op.
const STUBBED_MODULES = ['marked', 'electron', './config_local.js']

function stubModulesPlugin(names) {
  const set = new Set(names)
  return {
    name: 'stub-optional-modules',
    setup(build) {
      build.onResolve({filter: /.*/}, (args) => {
        if (set.has(args.path)) {
          return {path: args.path, namespace: 'stub-optional'}
        }
        return null
      })
      build.onLoad({filter: /.*/, namespace: 'stub-optional'}, () => ({
        contents: 'module.exports = new Proxy({}, {get: () => () => {}})',
        loader  : 'js',
      }))
    },
  }
}

async function loadApi() {
  const esbuild = await import('esbuild')
  const alias = await aliasFromTsconfig()

  const genEntry = resolve(REPO_ROOT, 'scripts/data_api', `.gen-entry-${process.pid}.mjs`)
  await writeFile(genEntry, GEN_ENTRY_SRC, 'utf8')

  let result
  try {
    result = await esbuild.build({
      entryPoints: [genEntry],
      bundle     : true,
      write      : false,
      format     : 'esm',
      platform   : 'node',
      target     : 'es2022',
      alias,
      // Match tools/esbuilder.js: tree-shaking reorders/drops bindings inside
      // the @framework/api barrel cycle and triggers a CustomDataElem TDZ.
      treeShaking: false,
      keepNames  : true,
      plugins    : [stubModulesPlugin(STUBBED_MODULES)],
      banner     : {js: DOM_STUB_BANNER},
      logLevel   : 'silent',
    })
  } finally {
    await rm(genEntry, {force: true})
  }

  const code = result.outputFiles[0].text
  const tmp = join(tmpdir(), `app-datapaths-${process.pid}-${Date.now()}.mjs`)
  await writeFile(tmp, code, 'utf8')

  // The bundled app includes a disk-backed localStorage shim that, on load,
  // reads ./localStorage.json and logs a benign ENOENT when it's missing.
  // Pre-create an empty backing file (removed afterward) so the read succeeds
  // silently, and filter the line as a fallback, keeping gen / `pnpm typecheck`
  // output clean.
  const lsBacking = resolve(REPO_ROOT, 'localStorage.json')
  let createdBacking = false
  if (!existsSync(lsBacking)) {
    await writeFile(lsBacking, '{}', 'utf8')
    createdBacking = true
  }
  const realLog = console.log
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('localStorage.json')) return
    realLog(...args)
  }

  try {
    try {
      const mod = await import(pathToFileURL(tmp).href)
      return finishLoad(mod)
    } catch (err) {
      if (process.env.GEN_DATAPATHS_DEBUG) {
        const lines = code.split('\n')
        const m = String(err?.stack ?? '').match(/app-datapaths-[^:]+:(\d+)/)
        await writeFile(resolve(REPO_ROOT, 'appbundle.debug.mjs'), code, 'utf8')
        if (m) {
          const n = +m[1]
          console.error(`--- bundle around line ${n} ---`)
          console.error(
            lines
              .slice(n - 6, n + 2)
              .map((l, i) => `${n - 5 + i}: ${l}`)
              .join('\n')
          )
        }
      }
      throw err
    }
  } finally {
    console.log = realLog
    if (createdBacking) await rm(lsBacking, {force: true})
    await rm(tmp, {force: true})
  }
}

function finishLoad(mod) {
  const exported = mod[EXPORT_NAME] ?? mod.default
  if (exported === undefined) {
    throw new Error(`api_define.js has no export "${EXPORT_NAME}" (or default)`)
  }
  const api = typeof exported === 'function' ? exported() : exported
  if (!api?.rootContextStruct) {
    throw new Error(`"${EXPORT_NAME}" did not yield a DataAPI with a rootContextStruct`)
  }
  return api
}

async function main() {
  let api
  try {
    api = await loadApi()
  } catch (err) {
    console.error('[gen-datapaths] failed to load scripts/data_api/api_define.js:')
    console.error('  ' + (err?.stack ?? err?.message ?? err))
    process.exitCode = 1
    return
  }

  const entries = walkAPI(api)
  const seen = new Set()
  const unique = []
  for (const e of entries) {
    const key = normalizePath(e.path)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(e)
  }

  // Canonical (lexicographic) ordering. walkAPI yields entries in DataAPI
  // struct-build / traversal order, and renderJSON / renderMarkdown preserve
  // that input order (markdown only sorts top-level group keys, not entries
  // within a group; renderDts already sorts its literals internally). Sorting
  // by normalized path here decouples the on-disk catalog order from the build
  // order, so reordering when/how structs are populated (e.g. registry-driven
  // defineAPI) produces no spurious catalog diffs — only real content changes.
  unique.sort((a, b) => {
    const ka = normalizePath(a.path)
    const kb = normalizePath(b.path)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  await mkdir(OUT_DIR, {recursive: true})
  const json = renderJSON(unique)
  await writeFile(join(OUT_DIR, 'api-paths.json'), json, 'utf8')
  await writeFile(join(OUT_DIR, 'API_PATHS.md'), renderMarkdown(unique), 'utf8')
  await writeFile(join(OUT_DIR, 'datapaths.ts'), renderDts(unique, AUGMENT_MODULE), 'utf8')

  // Copy the catalog where path.ux's ESLint rule expects it.
  await mkdir(dirname(ESLINT_CATALOG), {recursive: true})
  await writeFile(ESLINT_CATALOG, json, 'utf8')

  console.log(
    `[gen-datapaths] wrote ${unique.length} paths to scripts/data_api/generated/ ` +
      `(api-paths.json, API_PATHS.md, datapaths.ts) + eslint catalog copy`
  )
}

main()
  .catch((err) => {
    console.error('[gen-datapaths]', err?.stack ?? err)
    process.exitCode = 1
  })
  .finally(() => {
    // The loaded app may register timers/animation frames that keep the event
    // loop alive; exit explicitly once artifacts are written.
    process.exit(process.exitCode ?? 0)
  })
