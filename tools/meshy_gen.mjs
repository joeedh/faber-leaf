#!/usr/bin/env node
// Generate a test asset with Meshy Text-to-3D and drop it into
// sculptcore/tests/assets/<slug>.obj. Streams progress as the remesh-app
// protocol (PROGRESS/RESULT/ERROR) on stdout so the debug app can show it live.
//
// Usage: node tools/meshy_gen.mjs --prompt "a ceramic teapot" [--name slug]
//                                 [--out <dir>] [--poll-ms 3000]
//
// SECURITY: the API key lives in keys/meshy.txt (gitignored). This script
// refuses to run if that path is git-TRACKED, and never prints the key.

import {execFileSync} from 'node:child_process'
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve, join} from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const keyPath = join(repoRoot, 'keys', 'meshy.txt')
const defaultOut = join(repoRoot, 'sculptcore', 'tests', 'assets')
const API = 'https://api.meshy.ai/openapi/v2/text-to-3d'

function fail(msg) {
  process.stdout.write(`ERROR ${msg}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const a = {pollMs: 3000, out: defaultOut}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--prompt') a.prompt = argv[++i]
    else if (k === '--name') a.name = argv[++i]
    else if (k === '--out') a.out = argv[++i]
    else if (k === '--poll-ms') a.pollMs = parseInt(argv[++i], 10)
    else if (k === '-h' || k === '--help') {
      process.stdout.write('node tools/meshy_gen.mjs --prompt "..." [--name slug] [--out dir]\n')
      process.exit(0)
    } else fail(`unknown arg ${k}`)
  }
  return a
}

function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'meshy'
  )
}

// Refuse to run if the key file is tracked by git (it must stay gitignored).
function assertKeyUntracked() {
  if (!existsSync(keyPath)) fail(`no key at keys/meshy.txt (place your Meshy key there)`)
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', keyPath], {
      cwd  : repoRoot,
      stdio: 'ignore',
    })
    // exit 0 → the file IS tracked → unsafe.
    fail('keys/meshy.txt is git-tracked; refusing to read a key from version control')
  } catch {
    // non-zero exit → untracked → good.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uniquePct = (() => {
  let last = -1
  return (p) => {
    if (p <= last) return null
    last = p
    return p
  }
})()

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.prompt) fail('missing --prompt')
  assertKeyUntracked()

  const key = readFileSync(keyPath, 'utf8').trim()
  if (!key) fail('keys/meshy.txt is empty')
  const auth = {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'}

  process.stdout.write('PROGRESS 0 generating\n')

  // 1. Create a preview task (untextured base mesh — what we want to remesh).
  let res = await fetch(API, {
    method : 'POST',
    headers: auth,
    body   : JSON.stringify({mode: 'preview', prompt: args.prompt, ai_model: 'meshy-5'}),
  })
  if (!res.ok) fail(`create failed: HTTP ${res.status} ${await res.text()}`)
  const created = await res.json()
  const id = created.result || created.id
  if (!id) fail(`create returned no task id: ${JSON.stringify(created)}`)

  // 2. Poll until SUCCEEDED, forwarding progress (cap at 95% until downloaded).
  let modelUrl
  for (;;) {
    await sleep(args.pollMs)
    res = await fetch(`${API}/${id}`, {headers: auth})
    if (!res.ok) fail(`poll failed: HTTP ${res.status}`)
    const task = await res.json()
    const pct = Math.min(95, Math.max(0, task.progress | 0))
    const p = uniquePct(pct)
    if (p !== null) process.stdout.write(`PROGRESS ${p} generating\n`)
    if (task.status === 'SUCCEEDED') {
      modelUrl = task.model_urls?.obj
      if (!modelUrl) fail('task succeeded but no OBJ url in model_urls')
      break
    }
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      fail(`task ${task.status}: ${task.task_error ? JSON.stringify(task.task_error) : ''}`)
    }
  }

  // 3. Download the OBJ into the assets dir.
  const dl = await fetch(modelUrl)
  if (!dl.ok) fail(`download failed: HTTP ${dl.status}`)
  const buf = Buffer.from(await dl.arrayBuffer())

  if (!existsSync(args.out)) mkdirSync(args.out, {recursive: true})
  let name = args.name ? slugify(args.name) : slugify(args.prompt)
  let outPath = join(args.out, `${name}.obj`)
  let n = 2
  while (existsSync(outPath)) {
    outPath = join(args.out, `${name}-${n++}.obj`)
  }
  writeFileSync(outPath, buf)

  process.stdout.write('PROGRESS 100 generating\n')
  // Forward slashes so the path is uniform for the C++ parent reader.
  process.stdout.write(`RESULT ${outPath.replace(/\\/g, '/')}\n`)
}

main().catch((e) => fail(e?.message ? e.message : String(e)))
