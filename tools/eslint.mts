import fs from 'fs'
import child_process from 'child_process'
import crypto from 'crypto'

function getRepoRoot() {
  return child_process.execSync('git rev-parse --show-toplevel').toString().trim()
}

interface EslintConfigCache {
  hash?: string
  version?: number
  ignores?: string[]
}

async function loadConfig() {
  const hashfile = './.eslint-cfg-hash'

  let cfgText = fs.readFileSync(getRepoRoot() + '/eslint.config.js', 'utf-8')
  let hash = crypto.createHash('md5').update(cfgText).digest('hex')
  const VERSION = 2

  let existing = '{}'
  if (fs.existsSync('.eslintcfgcache.json')) {
    existing = fs.readFileSync('.eslintcfgcache.json', 'utf-8')
  }

  let parsed: EslintConfigCache | undefined

  try {
    parsed = JSON.parse(existing) as EslintConfigCache
  } catch (error) {
    console.log((error as any).message)
    console.log((error as any).stack)
  }

  let ok = parsed?.hash === hash && parsed?.version === VERSION && parsed?.ignores !== undefined
  if (ok) {
    delete parsed!.hash
    delete parsed!.version
    return {ignores: parsed!.ignores!.map((i) => globToRegExp(i))}
  }

  const config = (await import('../eslint.config.js')).default

  function globToRegExp(glob: string): RegExp {
    let escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    escaped = escaped.replace(/\\*\*/g, '::::')
    escaped = escaped.replace(/\*/g, '[^/]*')
    escaped = escaped.replace(/::::/g, '.*')
    const regexString = '^' + escaped + '$'
    return new RegExp(regexString)
  }

  function loadIgnores() {
    const ignores = ['**/node_modules/**', '**/.git/**']
    for (const item of config) {
      for (const pattern of item.ignores ?? []) {
        ignores.push(pattern)
      }
    }
    return ignores
  }

  const ignores = loadIgnores()
  fs.writeFileSync(
    '.eslintcfgcache.json',
    JSON.stringify({
      hash, //
      version: VERSION,
      ignores,
    })
  )
  return {ignores: ignores.map((i) => globToRegExp(i))}
}

function isTSJS(path: string): boolean {
  return /\.(ts|tsx|js|mjs|cjs)$/.test(path)
}

async function run(path: string, eslintArgs: string[]) {
  const {ignores} = await loadConfig()

  const files = [] as string[]

  function ignored(path: string) {
    for (const pattern of ignores) {
      if (pattern.test(path)) {
        return true
      }
    }
    return false
  }

  async function walk(dir: string) {
    const entries = fs.readdirSync(dir, {withFileTypes: true})
    for (const entry of entries) {
      const fullPath = dir + '/' + entry.name
      if (entry.isDirectory() && !ignored(fullPath)) {
        await walk(fullPath)
      } else {
        let ignore = false

        if (ignored(fullPath) || !isTSJS(fullPath)) {
          ignore = true
        }
        if (!ignore) {
          files.push(fullPath)
        }
      }
    }
  }
  await walk(path)

  const batchSize = 8
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    for (const file of batch) {
      console.log(file)
    }

    const cmdBase = 'pnpm exec eslint --cache --cache-strategy metadata'
    console.log(cmdBase + ' ' + [...eslintArgs, ...batch].join(' '))
    child_process.spawnSync(cmdBase, [...eslintArgs, ...batch], {shell: true, stdio: 'inherit'})
  }
}

run(process.argv[2] ?? '.', process.argv.slice(3))
