import fs from 'fs'
import Path from 'path'
import child_process from 'child_process'
import crypto from 'crypto'
import {pathToFileURL} from 'url'

function getRepoRoot() {
  return child_process.execSync('git rev-parse --show-toplevel').toString().trim()
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// Content-addressed cache write: the destination file name is a pure function of the
// content being written, so two processes racing on the same key always agree on the
// bytes and there is nothing to lock. Writing to a sibling temp file and renaming into
// place means a concurrent reader never observes a partially-written file (rename is
// atomic on both POSIX and Windows).
function casWrite(filePath: string, data: string) {
  fs.mkdirSync(Path.dirname(filePath), {recursive: true})
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, data)
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    // A concurrent writer may have already produced this exact key - since the content is
    // determined entirely by the key, that's a win, not a conflict.
    if (!fs.existsSync(filePath)) {
      throw error
    }
  }
}

function casRead<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    // Treat a corrupt/partial read (e.g. a reader landing between a concurrent writer's
    // existsSync and rename) as a cache miss rather than failing the whole run.
    return undefined
  }
}

const CACHE_ROOT = Path.join(getRepoRoot(), '.eslintcache')
const CONFIG_CACHE_DIR = Path.join(CACHE_ROOT, 'config')
const RESULT_CACHE_DIR = Path.join(CACHE_ROOT, 'results')
const CONFIG_CACHE_VERSION = 3
const RESULT_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

interface IgnoreCacheEntry {
  ignores: string[]
}

interface CachedLintResult {
  errorCount: number
  output: string
}

function globToRegExp(glob: string): RegExp {
  let escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  escaped = escaped.replace(/\\*\*/g, '::::')
  escaped = escaped.replace(/\*/g, '[^/]*')
  escaped = escaped.replace(/::::/g, '.*')
  return new RegExp('^' + escaped + '$')
}

async function loadConfig(repoRoot: string) {
  const cfgPath = Path.join(repoRoot, 'eslint.config.js')
  const cfgText = fs.readFileSync(cfgPath, 'utf-8')
  const configHash = sha256(`${CONFIG_CACHE_VERSION}\n${cfgText}`)
  const cacheFile = Path.join(CONFIG_CACHE_DIR, `${configHash}.json`)

  const cached = casRead<IgnoreCacheEntry>(cacheFile)
  if (cached) {
    return {ignores: cached.ignores.map(globToRegExp), configHash}
  }

  const config = (await import(pathToFileURL(cfgPath).href)).default

  const ignores = ['**/node_modules/**', '**/.git/**']
  for (const item of config) {
    for (const pattern of item.ignores ?? []) {
      ignores.push(pattern)
    }
  }

  casWrite(cacheFile, JSON.stringify({ignores} satisfies IgnoreCacheEntry))
  return {ignores: ignores.map(globToRegExp), configHash}
}

function isTSJS(filePath: string): boolean {
  return /\.(ts|tsx|js|mjs|cjs)$/.test(filePath)
}

function eslintVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(Path.join(repoRoot, 'node_modules', 'eslint', 'package.json'), 'utf-8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function resultCacheKey(parts: {
  configHash: string
  eslintVersion: string
  argsKey: string
  relPath: string
  content: string
}): string {
  const {configHash, eslintVersion, argsKey, relPath, content} = parts
  return sha256([configHash, eslintVersion, argsKey, relPath, sha256(content)].join(' '))
}

interface EslintMessage {
  line?: number
  column?: number
  severity: number
  message: string
  ruleId?: string | null
}

interface EslintJsonResult {
  filePath: string
  errorCount: number
  messages: EslintMessage[]
}

// Runs `worker` over `items` with at most `limit` in flight at once.
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0
  async function lane(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, () => lane()))
}

function spawnCapture(cmd: string, args: string[]): Promise<{stdout: string; stderr: string}> {
  return new Promise((resolve) => {
    const proc = child_process.spawn(cmd, args, {
      shell: true,
      stdio: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf-8')
    proc.stderr.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => (stdout += chunk))
    proc.stderr.on('data', (chunk: string) => (stderr += chunk))
    proc.on('close', () => resolve({stdout, stderr}))
    proc.on('error', (error) => resolve({stdout, stderr: stderr + String(error)}))
  })
}

function formatResult(result: EslintJsonResult): string {
  if (result.messages.length === 0) {
    return ''
  }
  const lines = [result.filePath]
  for (const m of result.messages) {
    const severity = m.severity === 2 ? 'error' : 'warning'
    lines.push(`  ${m.line ?? 0}:${m.column ?? 0}  ${severity}  ${m.message}${m.ruleId ? '  ' + m.ruleId : ''}`)
  }
  lines.push('')
  return lines.join('\n') + '\n'
}

// Result-cache entries older than this were almost certainly produced by a file that no
// longer looks like this (edited, renamed, or reverted through another commit) - pruning
// keeps the CAS store from growing without bound. Best-effort: a locked file on Windows is
// left for the next prune pass rather than failing the run.
function pruneResultCache() {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(RESULT_CACHE_DIR, {withFileTypes: true})
  } catch {
    return
  }
  const cutoff = Date.now() - RESULT_CACHE_MAX_AGE_MS
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const entryPath = Path.join(RESULT_CACHE_DIR, entry.name)
    try {
      if (fs.statSync(entryPath).mtimeMs < cutoff) {
        fs.unlinkSync(entryPath)
      }
    } catch {
      // ignore
    }
  }
}

async function run(targetPath: string, rawEslintArgs: string[]) {
  if (targetPath === '--fix') {
    targetPath = '.'
    rawEslintArgs.push('--fix')
  }

  const fixMode = rawEslintArgs.includes('--fix')
  const repoRoot = getRepoRoot()
  const {ignores, configHash} = await loadConfig(repoRoot)
  const version = eslintVersion(repoRoot)

  // We always request `--format json` ourselves so batch output can be split per file and
  // cached; drop any `--format`/`-f` the caller passed so it can't collide with that.
  // `--jobs`/`-j` is ours too - how many eslint batches run at once - and never reaches eslint.
  const eslintArgs: string[] = []
  let jobs = 5
  for (let i = 0; i < rawEslintArgs.length; i++) {
    const arg = rawEslintArgs[i]
    if (arg === '--format' || arg === '-f') {
      i++
      continue
    }
    if (arg === '--jobs' || arg === '-j') {
      jobs = Number(rawEslintArgs[++i])
      continue
    }
    eslintArgs.push(arg)
  }

  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error(`--jobs must be a positive integer, got '${jobs}'`)
  }

  // Key representing the eslint arguments, excluding --fix which we have special logic for
  const argsKey = eslintArgs.filter((k) => k !== '--fix').join(' ')
  const files: string[] = []

  // create a file system tree
  function cachePath(key: string) {
    return Path.join(RESULT_CACHE_DIR, key.slice(0, 2), `${key}.json`)
  }

  function ignored(p: string) {
    return ignores.some((pattern) => pattern.test(p))
  }

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, {withFileTypes: true})
    for (const entry of entries) {
      const fullPath = dir + '/' + entry.name
      if (ignored(fullPath)) {
        continue
      }
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (isTSJS(fullPath)) {
        files.push(fullPath)
      }
    }
  }
  if (fs.statSync(targetPath)?.isDirectory()) {
    walk(targetPath)
  } else {
    files.push(targetPath)
  }

  const toLint: string[] = []
  let cachedClean = 0
  let cachedWithErrors = 0
  let hadErrors = false

  for (const file of files) {
    const relPath = Path.relative(repoRoot, Path.resolve(file)).split(Path.sep).join('/')
    const content = fs.readFileSync(file, 'utf-8')
    const key = resultCacheKey({configHash, eslintVersion: version, argsKey, relPath, content})
    let cached = casRead<CachedLintResult>(cachePath(key))

    if (cached?.output?.search(/allowDefaultProject/) !== -1) {
      // files that failed due to not existing in tsconfig should
      // not respect cache so we can fix it in .defaultProjectEslint.mjs
      // and not have to invalidate the entire ESLint cache.
      cached = undefined
    }
    if (!cached || (cached?.errorCount > 0 && fixMode)) {
      toLint.push(file)
      continue
    }

    if (cached.output) {
      process.stdout.write(cached.output)
    }
    if (cached.errorCount > 0) {
      cachedWithErrors++
      hadErrors = true
    } else {
      cachedClean++
    }
  }

  const batchSize = 8
  const batches: string[][] = []
  let curSize = 0
  for (let i = 0; i < toLint.length; i++) {
    if (batches.length === 0 || curSize > 1024 * 256) {
      // If the file is larger than 1MB, consider it a separate batch
      batches.push([])
      curSize = 0
    }

    let size = fs.statSync(toLint[i]).size

    batches.at(-1)!.push(toLint[i])
    curSize += size
  }

  // eslint-disable-next-line no-console
  console.log(
    `eslint: ${files.length} files, ${cachedClean + cachedWithErrors} from cache ` +
      `(${cachedWithErrors} with errors), ${toLint.length} to lint in ${batches.length} batches`
  )

  let finishedCount = 0

  interface QueueWrite {
    path: string
    content: string
  }
  const writeQueue: QueueWrite[] = []
  const pushQueue = (path2: string, content: string) => {
    writeQueue.push({path: path2, content})
  }
  const flushQueue = () => {
    const visit = new Set<string>()

    const time = performance.now()

    writeQueue.reverse()
    while (writeQueue.length > 0) {
      const {path: path2, content} = writeQueue.shift()!
      if (!visit.has(path2)) {
        casWrite(path2, content)
      }
      visit.add(path2)
    }
    console.log(`flushed queue in ${(performance.now() - time).toFixed(2)}ms`)
  }
  let lastFlush = performance.now()
  const flushInterval = 500

  // Batches run up to `jobs` at once, each spawning its own eslint process. Output is
  // built up per batch and written in one shot at the end so concurrent batches can't
  // interleave their lines on stdout.
  await runWithConcurrency(batches, jobs, async (batch) => {
    const log: string[] = []

    const args = ['--loglevel=error', 'exec', 'eslint', '--format', 'json', ...eslintArgs, ...batch]
    const {stdout, stderr} = await spawnCapture('pnpm', args)

    if (stderr) {
      log.push(stderr)
    }

    let results: EslintJsonResult[]
    try {
      results = JSON.parse(stdout)
    } catch {
      // eslint didn't produce JSON at all (e.g. a config error) - surface it raw and bail
      // on caching this batch rather than guessing at per-file results.
      log.push(stdout)
      console.log(log.join('\n'))
      hadErrors = true
      return
    }

    finishedCount++
    process.stdout.write(`Finished ${finishedCount} / ${batches.length} batches\n`)

    for (const result of results) {
      const text = formatResult(result)
      if (text) {
        log.push(text.replace(/\n$/, ''))
      }
      if (result.errorCount > 0) {
        hadErrors = true
      }

      // Re-read from disk: --fix may have rewritten the file, and the cache key must
      // reflect the content eslint actually reported on, not the content we sent it.
      let finalContent: string
      try {
        finalContent = fs.readFileSync(result.filePath, 'utf-8')
      } catch {
        continue
      }
      const relPath = Path.relative(repoRoot, result.filePath).split(Path.sep).join('/')
      const key = resultCacheKey({configHash, eslintVersion: version, argsKey, relPath, content: finalContent})

      pushQueue(
        cachePath(key),
        JSON.stringify({errorCount: result.errorCount, output: text} satisfies CachedLintResult)
      )
      if (performance.now() - lastFlush > flushInterval) {
        flushQueue()
        lastFlush = performance.now()
      }
    }

    process.stdout.write(log.join('\n') + '\n')
  })

  flushQueue()
  pruneResultCache()
  process.exitCode = hadErrors ? 1 : 0
}

const startTime = performance.now()
run(process.argv[2] ?? '.', process.argv.slice(3))
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error)
    process.exitCode = 1
  })
  .then(() => {
    process.stdout.write(`Total time: ${((performance.now() - startTime) / 1000.0).toFixed(2)}s\n`)
  })
