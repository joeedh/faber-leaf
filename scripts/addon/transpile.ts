/**
 * Install-time transpiler for source-mode addons. Step 9d of the refactor
 * (plan §2.3, §6 step 9).
 *
 * Source-mode third-party addons ship their TypeScript sources inside the
 * zip and we transpile them at install time via esbuild-wasm. Single esbuild
 * pass per addon, ESM output, bundled into a single .js (no splitting — keeps
 * the runtime loader simple, see plan §6 step 9a).
 *
 * The transpiler is loaded lazily on the first source-mode install so the
 * ~10MB wasm payload doesn't bloat the idle main bundle. Subsequent installs
 * reuse the same initialized esbuild instance.
 */

import type {IAddonManifest} from './manifest.js'

// Minimal subset of the esbuild module shape we use. Both esbuild-wasm and
// esbuild-node expose this.
interface IEsbuildBuildResult {
  outputFiles?: {path: string; contents: Uint8Array; text: string}[]
  errors: {text: string}[]
  warnings: {text: string}[]
}
interface IEsbuildBuildOptions {
  stdin?: {
    contents: string
    loader?: 'ts' | 'tsx' | 'js' | 'jsx'
    sourcefile?: string
    resolveDir?: string
  }
  bundle?: boolean
  format?: 'esm' | 'cjs' | 'iife'
  target?: string
  platform?: 'browser' | 'node' | 'neutral'
  write?: false
  outfile?: string
  plugins?: unknown[]
}
interface IEsbuildModule {
  initialize?(opts: {wasmURL?: string; wasmModule?: WebAssembly.Module}): Promise<void>
  build(opts: IEsbuildBuildOptions): Promise<IEsbuildBuildResult>
}

let esbuildPromise: Promise<IEsbuildModule> | null = null

export class TranspileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranspileError'
  }
}

/**
 * Dynamic-imports esbuild-wasm (or, in tests/Node, the regular esbuild),
 * initialises it once, and caches the module-promise for reuse.
 *
 * The wasm asset is loaded from the same origin via the default
 * `wasmURL: '<esbuild-wasm pkg>/esbuild.wasm'` resolution. Hosts that need
 * to override the URL (e.g. to serve from a CDN) should call this function
 * directly with `{wasmURL}` before any addon install.
 */
export async function getEsbuild(opts?: {wasmURL?: string}): Promise<IEsbuildModule> {
  if (esbuildPromise) return esbuildPromise
  esbuildPromise = (async () => {
    const mod = (await import('esbuild-wasm')) as unknown as IEsbuildModule
    if (typeof mod.initialize === 'function') {
      try {
        await mod.initialize({wasmURL: opts?.wasmURL})
      } catch (err) {
        // esbuild-wasm throws if initialize() is called twice. The Node-side
        // esbuild doesn't have initialize. Either way, swallow and proceed.
        if (!String(err).includes('already')) {
          esbuildPromise = null
          throw err
        }
      }
    }
    return mod
  })()
  return esbuildPromise
}

/** Test helper — clears the cached esbuild promise. */
export function _resetEsbuildForTests(): void {
  esbuildPromise = null
}

/**
 * Transpiles a source-mode addon's files. Inputs and outputs are keyed by
 * POSIX relative path. The single entry file is bundled with esbuild's
 * stdin + a resolveDir-backed virtual filesystem so relative imports between
 * source files in the same zip work.
 *
 * On success the returned map contains:
 *   - manifest.json (unchanged, copied through)
 *   - <entry-stem>.js (the bundled output, named so the loader's
 *     manifest.entry.replace('.ts', '.js') resolves to it)
 *
 * Source files themselves are NOT included in the output map — the runtime
 * never re-reads them.
 */
export async function transpileAddonSources(
  manifest: IAddonManifest,
  files: Map<string, Uint8Array>
): Promise<Map<string, Uint8Array>> {
  const entryPath = manifest.entry
  const entryBytes = files.get(entryPath)
  if (!entryBytes) {
    throw new TranspileError(`entry "${entryPath}" not present in zip`)
  }

  const esbuild = await getEsbuild()

  // Build a virtual-fs plugin so esbuild can resolve relative imports
  // between source files in the addon zip without touching the real disk.
  const dec = new TextDecoder()
  const sources = new Map<string, string>()
  for (const [path, bytes] of files) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) {
      sources.set(path, dec.decode(bytes))
    }
  }

  const VFS_NAMESPACE = 'addon-vfs'

  const vfsPlugin = {
    name: 'addon-vfs',

    setup(build: any) {
      build.onResolve({filter: /.*/}, (args: {path: string; importer: string; namespace: string}) => {
        // Relative imports resolve against the importer's directory; bare
        // specifiers are external (we don't pull anything off npm at install
        // time). Only vfs-namespace importers carry a POSIX vfs path — the
        // stdin entry's importer is a real absolute path esbuild derived from
        // resolveDir (backslashed on Windows), so use the known entry dir.
        if (args.path.startsWith('.')) {
          const importerDir =
            args.namespace === VFS_NAMESPACE ? args.importer.replace(/[^/]+$/, '') : entryPath.replace(/[^/]+$/, '')
          const resolved = normalizeJoin(importerDir, args.path)
          // Look up with and without ts/js extension variations.
          for (const candidate of expandExtensionGuesses(resolved)) {
            if (sources.has(candidate)) {
              return {path: candidate, namespace: VFS_NAMESPACE}
            }
          }
          return {errors: [{text: `addon vfs: cannot resolve "${args.path}" from "${args.importer}"`}]}
        }
        // Bare specifier — mark external so the bundle output keeps the
        // import statement intact for the runtime loader to handle.
        return {path: args.path, external: true}
      })
      build.onLoad({filter: /.*/, namespace: VFS_NAMESPACE}, (args: {path: string}) => {
        const contents = sources.get(args.path)
        if (contents === undefined) {
          return {errors: [{text: `addon vfs: ${args.path} missing`}]}
        }
        const loader = /\.tsx$/.test(args.path) ? 'tsx' : /\.ts$/.test(args.path) ? 'ts' : 'js'
        return {contents, loader}
      })
    },
  }

  let result: IEsbuildBuildResult
  try {
    result = await esbuild.build({
      stdin: {
        contents  : sources.get(entryPath) ?? '',
        loader    : /\.tsx$/.test(entryPath) ? 'tsx' : 'ts',
        sourcefile: entryPath,
        resolveDir: '/',
      },
      bundle  : true,
      format  : 'esm',
      target  : 'es2022',
      platform: 'browser',
      write   : false,
      outfile : 'out.js',
      plugins : [vfsPlugin],
    })
  } catch (err) {
    throw new TranspileError(`esbuild failed: ${(err as Error).message}`)
  }

  if (result.errors.length > 0) {
    throw new TranspileError(`esbuild errors:\n${result.errors.map((e) => '  ' + e.text).join('\n')}`)
  }

  const out = (result.outputFiles ?? [])[0]
  if (!out) {
    throw new TranspileError('esbuild produced no output')
  }

  // Build the output map. The runtime loader does
  // `entry.replace(/\.ts$/, '.js')` to derive the URL path; produce a .js
  // file at exactly that location so the lookup works.
  const outBytes = out.contents instanceof Uint8Array ? out.contents : new TextEncoder().encode(out.text)
  const outRel = entryPath.replace(/\.tsx?$/i, '.js')

  const outFiles = new Map<string, Uint8Array>()
  outFiles.set(outRel, outBytes)
  // Always carry the manifest through unchanged.
  const manifestBytes = files.get('manifest.json')
  if (manifestBytes) {
    outFiles.set('manifest.json', manifestBytes)
  }

  return outFiles
}

function normalizeJoin(dir: string, rel: string): string {
  const parts = (dir + '/' + rel).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

function expandExtensionGuesses(p: string): string[] {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p)) return [p]
  return [p + '.ts', p + '.tsx', p + '.js', p + '.jsx', p + '/index.ts', p + '/index.js']
}
