#!/usr/bin/env node
/**
 * Per-addon esbuild driver. Discovers every `addons/builtin/<id>/manifest.json`,
 * bundles each addon's TypeScript entry into `build/addons/<id>/<entry>.js`,
 * and writes `build/addons/index.json` for the runtime loader. See plan §2.3,
 * §6 step 5.
 *
 * Usage:
 *   node tools/build-addons.js          # one-shot build
 *   node tools/build-addons.js --watch  # watch mode
 *   node tools/build-addons.js --include-fixtures  # also build tests/fixtures/addons/*
 *   node tools/build-addons.js --release  # release build: no source maps
 *
 * Each addon is bundled as ESM with `splitting: true` and shared chunks in
 * `build/addons/_chunks/`. The bundling currently inlines `scripts/*` imports
 * — the runtime resolver that maps externals to the main bundle lands in
 * step 5c.
 */

import * as esbuild from 'esbuild'
import fs from 'fs'
import Path from 'path'
import {fileURLToPath} from 'url'

import {addonApiPlugin} from './addon_api_plugin.js'
import {frameworkApiPlugin} from './framework_api_plugin.js'
import {checkFromFiles, EXTERNAL_IDS, IN_BUNDLE_BUILTIN_IDS} from './check-addon-duplication.js'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '..')
const MAIN_META_PATH = Path.join(REPO_ROOT, 'build', 'meta-main.json')
const ADDON_META_PATH = Path.join(REPO_ROOT, 'build', 'addons', 'meta-addons.json')

/**
 * Stub out framework-global side-effect imports (numeric.js, the extern Math
 * shim, jszip) in addon bundles. These libraries attach themselves to
 * `globalThis` and are loaded once by the host bundle before any addon runs,
 * so addons import them purely for their side effect. Left as plain esbuild
 * externals they emit a relative specifier (e.g. `../../scripts/util/
 * numeric.js`) that esbuild rebases against the addon `outbase`; from the
 * deeper `build/addons/_chunks/` output dir that path resolves to
 * `/build/scripts/...` and 404s. Resolving them to an empty module drops the
 * redundant (and broken) re-fetch and works in both the web and electron
 * layouts since the global is already present.
 */
function frameworkGlobalsStubPlugin() {
  const STUB =
    /(^|\/)(numeric(\.js)?|scripts\/util\/numeric(\.js)?|scripts\/extern\/Math(\.js)?|scripts\/extern\/jszip\/.*)$/
  return {
    name: 'framework-globals-stub',
    setup(build) {
      build.onResolve({filter: STUB}, (args) => ({path: args.path, namespace: 'framework-global-stub'}))
      build.onLoad({filter: /.*/, namespace: 'framework-global-stub'}, () => ({
        contents: '',
        loader  : 'js',
      }))
    },
  }
}

const args = process.argv.slice(2)
const WATCH = args.includes('--watch') || args.includes('-w')
const INCLUDE_FIXTURES = args.includes('--include-fixtures')
// Passed through by tools/esbuilder.js --release. See documentation/releaseBuild.md.
const RELEASE = args.includes('--release')

const BUILTIN_DIR = Path.join(REPO_ROOT, 'addons', 'builtin')
const FIXTURE_DIR = Path.join(REPO_ROOT, 'tests', 'fixtures', 'addons')
const OUT_DIR = Path.join(REPO_ROOT, 'build', 'addons')

/**
 * Scans a directory for manifests. Returns objects shaped like
 * `{id, manifestPath, addonDir, manifest}`.
 */
function discoverManifests(rootDir, kind) {
  if (!fs.existsSync(rootDir)) return []
  const out = []
  for (const name of fs.readdirSync(rootDir)) {
    const addonDir = Path.join(rootDir, name)
    const stat = fs.statSync(addonDir)
    if (!stat.isDirectory()) continue
    const manifestPath = Path.join(addonDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (err) {
      console.error(`failed to parse ${manifestPath}: ${err.message}`)
      continue
    }
    if (manifest.id !== name) {
      console.error(`${manifestPath}: manifest.id ("${manifest.id}") must match directory name ("${name}")`)
      continue
    }
    out.push({id: manifest.id, manifestPath, addonDir, manifest, kind})
  }
  return out
}

function buildOptionsFor(entries) {
  return {
    entryPoints: entries.map(({entryPath, outPath}) => ({in: entryPath, out: outPath})),
    outdir     : OUT_DIR,
    bundle     : true,
    target     : 'es2022',
    sourcemap  : RELEASE ? false : 'inline',
    minify     : false,
    treeShaking: false,
    logLevel   : 'info',
    format     : 'esm',
    platform   : 'browser',
    splitting  : true,
    keepNames  : true,
    metafile   : true,
    chunkNames : '_chunks/[name]-[hash]',
    logOverride: {'direct-eval': 'silent'},
    // `@framework/api` and `@framework/pathux` are NOT aliased to local files
    // here — the frameworkApiPlugin below resolves them to runtime-lookup
    // stubs against globalThis._framework so framework source is not
    // duplicated into addon bundles. The tsconfig paths still alias them
    // for typecheck purposes.
    // Mirror the main esbuilder's externals — pathux references `electron`
    // and `fs` for its Node/Electron path-controller backend. Real addon
    // code never reaches those modules at runtime in the browser.
    external: [
      'fs',
      'fs/promises',
      'path',
      'marked',
      'electron',
      'numeric',
      'numeric.js',
      'scripts/util/numeric',
      './scripts/util/numeric.js',
      './scripts/extern/Math.js',
      './scripts/extern/Math',
      './scripts/extern/jszip/*',
      // Match main esbuilder — sculptcore wasm glue does node-only `import
      // 'node:module'` / `node:worker_threads` at the top. The runtime never
      // hits those code paths in the browser; the main bundle externalizes
      // this file and we mirror that here so addons that transitively reach
      // scripts/webgl/batch.ts (via Mesh / SimpleMesh chains) don't choke.
      '*/build/sculptcore.js',
    ],
    // @addon/<id>/api imports get resolved to a tiny runtime-lookup stub
    // instead of inlining the upstream addon's code. See plan §2.5.
    // @framework/api and @framework/pathux are resolved similarly against
    // globalThis._framework (set in scripts/_framework_runtime.ts).
    plugins    : [frameworkGlobalsStubPlugin(), frameworkApiPlugin(REPO_ROOT), addonApiPlugin(REPO_ROOT)],
  }
}

async function build() {
  // In-bundle builtins ship inside the main bundle, imported by whichever
  // distribution lists them — they must NOT be separately compiled here (that
  // would produce a dead, duplicated bundle). Only external addons get built.
  const builtins = discoverManifests(BUILTIN_DIR, 'builtin').filter((m) => !IN_BUNDLE_BUILTIN_IDS.has(m.id))
  const fixtures = INCLUDE_FIXTURES ? discoverManifests(FIXTURE_DIR, 'fixture') : []
  const all = [...builtins, ...fixtures]

  if (all.length === 0) {
    console.log('No addon manifests found.')
    fs.mkdirSync(OUT_DIR, {recursive: true})
    fs.writeFileSync(Path.join(OUT_DIR, 'index.json'), '[]\n')
    return
  }

  const entries = []
  const index = []

  for (const m of all) {
    const entryPath = Path.join(m.addonDir, m.manifest.entry)
    if (!fs.existsSync(entryPath)) {
      console.error(`${m.manifestPath}: entry "${m.manifest.entry}" does not exist`)
      continue
    }
    // out path: <id>/<entry stem>, esbuild appends .js
    const entryStem = m.manifest.entry.replace(/\.(ts|tsx|js|mjs)$/, '')
    const outPath = `${m.id}/${entryStem}`
    entries.push({entryPath, outPath, id: m.id})

    index.push({
      manifest: m.manifest,
      builtin : m.kind === 'builtin',
      kind    : m.kind,
    })
  }

  const opts = buildOptionsFor(entries)

  if (WATCH) {
    // In watch mode, write the metafile + run the duplication guard on every
    // rebuild via an onEnd hook.
    const watchOpts = {
      ...opts,
      plugins: [
        ...opts.plugins,
        {
          name: 'addon-meta-and-guard',
          setup(build) {
            build.onEnd((result) => {
              if (!result.metafile) return
              fs.mkdirSync(OUT_DIR, {recursive: true})
              fs.writeFileSync(ADDON_META_PATH, JSON.stringify(result.metafile))
              checkFromFiles(MAIN_META_PATH, ADDON_META_PATH, EXTERNAL_IDS)
            })
          },
        },
      ],
    }
    const ctx = await esbuild.context(watchOpts)
    await ctx.watch()
    console.log('build-addons: watching')
  } else {
    const result = await esbuild.build(opts)
    fs.mkdirSync(OUT_DIR, {recursive: true})
    if (result.metafile) {
      fs.writeFileSync(ADDON_META_PATH, JSON.stringify(result.metafile))
    }
  }

  fs.mkdirSync(OUT_DIR, {recursive: true})
  fs.writeFileSync(Path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  console.log(`build-addons: wrote ${index.length} addon(s) to ${OUT_DIR}`)

  if (!WATCH) {
    const violations = checkFromFiles(MAIN_META_PATH, ADDON_META_PATH, EXTERNAL_IDS)
    if (violations.length) {
      process.exitCode = 1
    }
  }
}

await build()
