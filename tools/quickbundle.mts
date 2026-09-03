import * as esbuild from 'esbuild'
import fs from 'node:fs'
import Path from 'node:path'
import {pathToFileURL} from 'node:url'
import * as crypto from 'node:crypto'

const CACHEDIR = '.quickbuild'

fs.mkdirSync(CACHEDIR, {recursive: true})

export async function quickBundle(
  entryFile: string,
  otherFiles: string[],
  options?: esbuild.BuildOptions,
  extraPrefix = ''
) {
  let entryFiles = [entryFile, ...otherFiles]
  entryFiles = entryFiles.map((f) => Path.resolve(f)).map((f) => Path.relative(process.cwd(), f))

  options = {
    entryPoints   : entryFiles,
    bundle        : true,
    entryNames    : '[dir]/[name]',
    metafile      : true,
    treeShaking   : true,
    target        : 'esnext',
    sourcemap     : false,
    platform      : 'node',
    allowOverwrite: true,
    keepNames     : true,
    // keep eslint from writing to disk itself
    write         : false,
    format        : 'esm',
    minify        : true,
    ...options,
  }
  const hashKey = crypto
    .createHash('sha256')
    .update(JSON.stringify(options) + [entryFile, entryFiles].join(';'))
    .digest('hex')
    .slice(0, 5)
  const cacheDir = Path.join(CACHEDIR, Path.basename(Path.basename(entryFile) + hashKey))

  options.outdir = cacheDir
  let outFileName = entryFiles[0]
  if (!outFileName.toLowerCase().endsWith('.js')) {
    outFileName += '.js'
  }
  const outFilePath = Path.join(cacheDir + extraPrefix, outFileName)
  const ext = options.format === 'cjs' ? '.cjs' : '.mjs'

  if (!fs.existsSync(cacheDir)) {
    process.stderr.write('[quickbundle] building module (one time only)\n')
    const meta = await esbuild.build(options)
    for (const result of meta.outputFiles!) {
      fs.mkdirSync(Path.dirname(result.path), {recursive: true})
      fs.writeFileSync(result.path, result.contents)
    }
    fs.mkdirSync(Path.dirname(outFilePath + ext), {recursive: true})
    fs.writeFileSync(outFilePath + ext, meta.outputFiles![0].contents)
  }
  return await import(pathToFileURL(outFilePath + ext).href)
}

const hashStr = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 5)

export async function quickBundleModule(moduleName: string, options?: esbuild.BuildOptions, returnDefault = false) {
  const outFile = `${CACHEDIR}/tmp-${hashStr(moduleName).replace(/\//g, '_')}.mjs`
  fs.writeFileSync(
    outFile,
    `
    export * from '${moduleName}';
  `
  )
  // esbuilds move-in-default semantics is not consisten,
  // so we explicitly check for the default export when requested
  const result = await quickBundle(outFile, [], options)
  return returnDefault && result.default ? result.default : result
}
