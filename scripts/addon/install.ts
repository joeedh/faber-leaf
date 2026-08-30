/**
 * Third-party addon install pipeline.
 *
 * `installFromBlob(blob, storage)`:
 *   1. Parse the zip via JSZip.
 *   2. Locate manifest.json (must be at zip root, no nesting), validate it.
 *   3. For prebuilt addons: write every file from the zip into storage, keyed
 *      by manifest.id. The entry path must exist as a built JS file.
 *   4. For source-mode addons: transpile src/* via esbuild-wasm, then write
 *      the produced JS + the manifest. (Lands in step 9d — currently this
 *      throws a "source-mode not yet supported" error.)
 *
 * Returns the validated manifest on success; throws on any validation or
 * extraction failure. See plan §2.3 / §2.6 / §6 step 9.
 */

import {IAddonManifest, ManifestValidationError, validateManifest} from './manifest.js'
import type {AddonStorage} from './storage.js'
import {transpileAddonSources, TranspileError} from './transpile.js'

export class AddonInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddonInstallError'
  }
}

interface IJSZipEntry {
  name: string
  dir: boolean
  async(type: 'uint8array'): Promise<Uint8Array>
  async(type: 'string'): Promise<string>
}

interface IJSZip {
  files: Record<string, IJSZipEntry>
}

interface IJSZipConstructor {
  loadAsync(data: ArrayBuffer | Uint8Array | Blob): Promise<IJSZip>
}

declare global {
  interface Window {
    JSZip?: IJSZipConstructor
  }

  var JSZip: IJSZipConstructor | undefined
}

async function loadJSZip(): Promise<IJSZipConstructor> {
  // JSZip is a UMD bundle (scripts/extern/jszip/jszip.js) that sets a global.
  const g = globalThis as unknown as {JSZip?: IJSZipConstructor}
  if (g.JSZip) return g.JSZip
  // Lazy import the UMD side-effect. Path resolves relative to this module.
  await import('../extern/jszip/jszip.js')
  if (!g.JSZip) {
    throw new AddonInstallError('JSZip failed to load')
  }
  return g.JSZip
}

export async function installFromBlob(
  blob: Blob | ArrayBuffer | Uint8Array,
  storage: AddonStorage
): Promise<IAddonManifest> {
  const JSZip = await loadJSZip()
  let zip: IJSZip
  try {
    zip = await JSZip.loadAsync(blob)
  } catch (err) {
    throw new AddonInstallError(`zip parse failed: ${(err as Error).message}`)
  }

  // 1. Locate + validate manifest.
  const manifestEntry = zip.files['manifest.json']
  if (!manifestEntry || manifestEntry.dir) {
    throw new AddonInstallError('manifest.json missing at zip root')
  }
  const manifestText = await manifestEntry.async('string')
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(manifestText)
  } catch (err) {
    throw new AddonInstallError(`manifest.json is not valid JSON: ${(err as Error).message}`)
  }

  let manifest: IAddonManifest
  try {
    manifest = validateManifest(manifestRaw, 'manifest.json')
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      throw new AddonInstallError(err.message)
    }
    throw err
  }

  // 2. Collect every file in the zip into a map. Strip leading "./" if present.
  const files = new Map<string, Uint8Array>()
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const normalized = normalizeZipPath(path)
    if (!normalized) {
      throw new AddonInstallError(`zip contains invalid path: ${JSON.stringify(path)}`)
    }
    files.set(normalized, await entry.async('uint8array'))
  }

  // 3. Source mode: transpile via esbuild-wasm. The output map contains a
  // single bundled .js at the location the loader expects + the manifest.
  // Prebuilt mode: the zip already contains the built JS; pass through.
  let installFiles: Map<string, Uint8Array>
  if (manifest.buildMode === 'source') {
    if (!files.has(manifest.entry)) {
      throw new AddonInstallError(`source-mode addon "${manifest.id}" missing entry "${manifest.entry}" in zip`)
    }
    try {
      installFiles = await transpileAddonSources(manifest, files)
    } catch (err) {
      if (err instanceof TranspileError) {
        throw new AddonInstallError(err.message)
      }
      throw err
    }
  } else {
    // Prebuilt: sanity-check that the manifest's entry exists. If the entry
    // ends in .ts, the loader normalizes to .js — accept either form.
    const entryJs = manifest.entry.replace(/\.ts$/, '.js')
    if (!files.has(entryJs) && !files.has(manifest.entry)) {
      throw new AddonInstallError(`manifest entry "${manifest.entry}" (or "${entryJs}") not found in zip`)
    }
    installFiles = files
  }

  // 4. Commit to storage. Replaces any previous install with the same id.
  await storage.write(manifest.id, installFiles)

  return manifest
}

function normalizeZipPath(p: string): string | undefined {
  if (p.includes('..')) return undefined
  if (p.startsWith('/')) p = p.substring(1)
  if (p.startsWith('./')) p = p.substring(2)
  // Reject Windows-style absolutes (unlikely but defensive).
  if (/^[A-Za-z]:/.test(p)) return undefined
  return p.replace(/\\/g, '/')
}
