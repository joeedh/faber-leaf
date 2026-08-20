/**
 * P20 criterion 15: the app mounts into a container, unmounts cleanly, and two
 * instances coexist on one page.
 *
 * Drives the real NW.js app headlessly (the same mechanism as
 * node_editor_ops.test.ts) and reaches `mountFaberLeaf` the way an embedder
 * does — by importing the shipped bundle. That is deliberate: if the embedding
 * export ever stops being reachable from `build/entry_point.js`, this fails.
 *
 * Covers:
 *   - mount → unmount, three times: the registry and the container return to
 *     their starting size every round (no leaked instances or DOM).
 *   - two instances live at once, each with its own datalib, screen and
 *     container, and a ToolOp run against one lands only in that one.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app
 * bundle (`build/entry_point.js`, `pnpm build`). Backend-agnostic — it never
 * touches sculptcore — so it runs once, in the default-backend pass.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfileArgs, resolveNwjsExe} from './nwjs_boot'
import {isDefaultBackendPass} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')

interface Dump {
  evalResult?: unknown
}

/** Boot headlessly on the empty scene, run one `--eval`, return its dump. */
function runEval(nwExe: string, expr: string): unknown {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'mountlife-')), 'dump.json')

  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      'wasm',
      '--gen-scene',
      'empty',
      `--eval=${expr}`,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 180000}
  )

  if (!fs.existsSync(out)) {
    throw new Error(`dump not written to ${out}`)
  }
  return (JSON.parse(fs.readFileSync(out, 'utf-8')) as Dump).evalResult
}

/**
 * `--eval` runs through an indirect eval, so top-level await is unavailable;
 * each expression is an async IIFE that parks its answer on __evalTestResult.
 * The bundle URL is resolved off document.baseURI because the NW.js shell's
 * window.html sits one directory below the app root.
 */
function evalScript(body: string): string {
  return `(async () => {
    try {
      const mod = await import(new URL('../build/entry_point.js', document.baseURI).href)
      globalThis.__evalTestResult = await (async () => { ${body} })()
    } catch (err) {
      globalThis.__evalTestResult = {error: String(err && err.stack || err)}
    }
  })()`
}

const MOUNT_UNMOUNT_LOOP = evalScript(`
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px;height:300px'
  document.body.appendChild(host)

  const baseline = mod.mountedInstances().length
  const mounted = []
  const afterUnmount = []

  for (let i = 0; i < 3; i++) {
    const handle = await mod.mountFaberLeaf(host, {activate: false})
    mounted.push(mod.mountedInstances().length)
    handle.unmount()
    afterUnmount.push(mod.mountedInstances().length)
  }

  const hostChildren = host.children.length
  host.remove()

  return {baseline, mounted, afterUnmount, hostChildren}
`)

const TWO_INSTANCES = evalScript(`
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px;height:300px'
  document.body.appendChild(host)

  const first = mod.mountedInstances()[0]
  const handle = await mod.mountFaberLeaf(host, {activate: false})
  const second = handle.state

  const materialsOf = (state) => [...state.datalib.material].length
  const before = [materialsOf(first), materialsOf(second)]

  second.ctx.api.execTool(second.ctx, 'material.new()')
  const after = [materialsOf(first), materialsOf(second)]

  const result = {
    count           : mod.mountedInstances().length,
    distinctState   : first !== second,
    distinctDatalib : first.datalib !== second.datalib,
    distinctScreen  : first.screen !== second.screen,
    secondInHost    : host.contains(second.screen),
    firstOutsideHost: !host.contains(first.screen),
    bothListening   : Boolean(first.screen.listening) && Boolean(second.screen.listening),
    before,
    after,
  }

  handle.unmount()
  host.remove()

  return result
`)

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const runnable = Boolean(nwExe) && haveBundle && isDefaultBackendPass()

if (!runnable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[mount-lifecycle] skipped (nwjs=${Boolean(nwExe)} bundle=${haveBundle} defaultPass=${isDefaultBackendPass()})`
  )
}

const maybe = runnable ? describe : describe.skip

maybe('mountFaberLeaf lifecycle', () => {
  test('mount → unmount, three times, leaks nothing', () => {
    const r = runEval(nwExe!, MOUNT_UNMOUNT_LOOP) as {
      error?: string
      baseline: number
      mounted: number[]
      afterUnmount: number[]
      hostChildren: number
    }

    expect(r?.error).toBeUndefined()
    expect(r.baseline).toBe(1)
    expect(r.mounted).toEqual([2, 2, 2])
    expect(r.afterUnmount).toEqual([1, 1, 1])
    expect(r.hostChildren).toBe(0)
  }, 200000)

  test('two instances coexist with independent documents', () => {
    const r = runEval(nwExe!, TWO_INSTANCES) as {
      error?: string
      count: number
      distinctState: boolean
      distinctDatalib: boolean
      distinctScreen: boolean
      secondInHost: boolean
      firstOutsideHost: boolean
      bothListening: boolean
      before: number[]
      after: number[]
    }

    expect(r?.error).toBeUndefined()
    expect(r.count).toBe(2)
    expect(r.distinctState).toBe(true)
    expect(r.distinctDatalib).toBe(true)
    expect(r.distinctScreen).toBe(true)
    expect(r.secondInHost).toBe(true)
    expect(r.firstOutsideHost).toBe(true)
    expect(r.bothListening).toBe(true)
    // material.new() ran against the second instance only.
    expect(r.after[0]).toBe(r.before[0])
    expect(r.after[1]).toBe(r.before[1] + 1)
  }, 200000)
})
