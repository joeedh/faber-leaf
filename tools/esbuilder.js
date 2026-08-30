/* eslint-disable no-console */
import * as esbuild from 'esbuild'
import fs from 'fs'
import Path from 'path'
import {fileURLToPath} from 'url'

import {addonApiPlugin} from './addon_api_plugin.js'
import {builtinEntryAliases, collectBuildAssets, describeUnavailable} from './builtin_addons.js'
import {distributionEntry, inBundleBuiltinIds, listDistributions, resolveDistributionName} from './distributions.mjs'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '..')
const MAIN_META_PATH = Path.join(REPO_ROOT, 'build', 'meta-main.json')

// Release build mode (`pnpm build:release`, used by the Pages CI): no source
// maps anywhere — this bundle plus, via buildAddons(), the addon bundles.
// See documentation/releaseBuild.md.
const RELEASE = process.argv.includes('--release')

// Which product this bundle is. `@distribution` is aliased to its manifest, and
// the manifest's in-bundle addon set decides which build assets get copied.
const DISTRIBUTION = resolveDistributionName()
const DISTRIBUTION_ENTRY = distributionEntry(DISTRIBUTION)
const IN_BUNDLE_IDS = inBundleBuiltinIds(DISTRIBUTION)
console.log(`esbuilder: distribution "${DISTRIBUTION}" (in-bundle: ${[...IN_BUNDLE_IDS].join(', ') || 'none'})`)

// Entry points and externals contributed by the builtin addons that are in this
// build (manifest `buildAssets`) *and* that this distribution ships. An addon
// whose optional workspace dependency did not install is not in this build, so
// it contributes nothing and its artifacts stop being a missing-file error.
const ADDON_ASSETS = collectBuildAssets(undefined, IN_BUNDLE_IDS)
for (const line of describeUnavailable()) {
  console.log(`esbuilder: ${line}`)
}

/* Sourcemap mode. --release wins (none emitted at all); otherwise
 * ESBUILD_SOURCEMAP (inline | external | linked | both | none), defaulting to
 * inline for local dev — one file, no extra fetch. */
function resolveSourcemap() {
  if (RELEASE) {
    return false
  }
  const mode = process.env.ESBUILD_SOURCEMAP
  if (!mode) {
    return 'inline'
  }
  return mode === 'none' || mode === 'false' ? false : mode
}

let options = {
  entryPoints: [
    './scripts/entry_point.js',
    // Autosave compression worker (plan §5.4). Stable, unhashed name so the
    // host can spawn `build/autosave_worker.js` as a sibling module worker.
    {in: './scripts/core/autosave_worker.ts', out: 'autosave_worker'},
    // Addon-contributed entries (manifest `buildAssets`). Each `out` is an
    // unhashed stem, because an engine artifact that names its own siblings at
    // runtime cannot survive content hashing — documentation/addons.md.
    ...ADDON_ASSETS.entryPoints,
  ],
  alias: {
    '@framework/api': Path.join(REPO_ROOT, 'scripts', 'framework_api.ts'),
    // entry_point.js names the product it was built for by this alias and
    // nothing else; tsconfig.paths.json points it at the default for typecheck.
    '@distribution' : DISTRIBUTION_ENTRY,
    // Mirrors the `@builtin/<id>` paths in tsconfig.paths.json — an addon that
    // is not in this build resolves to the stub, so its subtree never enters
    // the bundle and registerBuiltin records it as not-in-build.
    ...builtinEntryAliases(),
  },
  outdir     : './build',
  bundle     : true,
  target     : 'es2022',
  sourcemap  : resolveSourcemap(),
  minify     : false,
  treeShaking: false,
  logLevel   : 'info',
  format     : 'esm',
  platform   : 'browser',
  loader     : {'.wasm': 'copy'},
  external: [
    'fs',
    'fs/promises',
    'path',
    'os',
    'marked',
    ...ADDON_ASSETS.external,
    // path.ux retains its electron platform (additive); its static
    // require("electron") must stay external even though the app uses NW.js.
    'electron',
    'scripts/util/numeric.js',
    // config_local.js is optional + gitignored: external it by the RELATIVE
    // import specifier too, so builds succeed when the file doesn't exist.
    'scripts/config/config_local.js',
    './config_local.js',
    'numeric',
    'numeric.js',
    'scripts/util/numeric',
    './scripts/util/numeric.js',
    './scripts/util/numeric',
    './scripts/extern/Math.js',
    './scripts/extern/Math',
    './scripts/extern/jszip/*',
  ],
  splitting  : true,
  keepNames  : true,
  metafile   : true,
  logOverride: {'direct-eval': 'silent'},
  // Resolve `@addon/<id>/api` imports in main-bundle code to a runtime-lookup
  // stub (globalThis._addons.getAddonAPI(id).exports[id]) instead of inlining
  // the addon's source. This lets main-bundle code reference an addon without
  // statically pulling its code in — the prerequisite for extracting addons to
  // their own bundles without duplication.
  //
  // NOTE: the stub binds at the consumer module's *load time*, which in the
  // main bundle is before start() enables any addon — so the bindings are
  // `undefined` if read eagerly at module scope. Main-bundle code must access
  // addon exports lazily (via the getters in scripts/addon/addon_base.ts), not
  // through eager `@addon/<id>/api` value imports. `@framework/api` stays an
  // alias to the real file: the main bundle *is* the framework.
  plugins    : [addonApiPlugin(REPO_ROOT)],
}

// After the main bundle finishes, build any addon manifests we discover.
// Kept inline so `npm run build` and `npm run watch` automatically rebuild
// addons too. See plan §2.3.
async function buildAddons(opts = {}) {
  const args = ['./tools/build-addons.js']
  if (opts.watch) args.push('--watch')
  if (opts.includeFixtures) args.push('--include-fixtures')
  if (opts.release) args.push('--release')
  args.push('--distribution', DISTRIBUTION)
  const {spawn} = await import('child_process')
  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, {stdio: 'inherit'})
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build-addons exited ${code}`))))
    proc.on('error', reject)
  })
}

const handlers = {
  async help() {
    console.log('\nUsage: esbuilder --watch,-w --release --distribution <name> --help\n')
    console.log(`  distributions: ${listDistributions().join(', ')}\n`)
  },
  async build() {
    const result = await esbuild.build(options)
    // Persist the main bundle's metafile so build-addons.js can run the
    // addon-duplication guard against it.
    if (result.metafile) {
      fs.mkdirSync(Path.dirname(MAIN_META_PATH), {recursive: true})
      fs.writeFileSync(MAIN_META_PATH, JSON.stringify(result.metafile))
    }
    await buildAddons({release: RELEASE})
  },

  async watch() {
    // Emit the main metafile on every rebuild so the addon watcher's guard
    // sees fresh inputs.
    const watchOptions = {
      ...options,
      plugins: [
        ...options.plugins,
        {
          name: 'write-main-metafile',
          setup(build) {
            build.onEnd((result) => {
              if (result.metafile) {
                fs.mkdirSync(Path.dirname(MAIN_META_PATH), {recursive: true})
                fs.writeFileSync(MAIN_META_PATH, JSON.stringify(result.metafile))
              }
            })
          },
        },
      ],
    }
    let ctx = await esbuild.context(watchOptions)
    await ctx.watch()
    // Run addon build in watch mode as a background child process so the
    // two watchers run concurrently.
    buildAddons({watch: true}).catch((err) => console.error('addons watcher:', err))
  },
}

let mode = 'build'
for (let arg of process.argv) {
  if (arg === '-w' || arg === '--watch') {
    mode = 'watch'
  }

  if (arg === '-h' || arg === '--help') {
    mode = 'help'
    break
  }
}

await handlers[mode]()
