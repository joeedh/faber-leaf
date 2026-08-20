/**
 * The UV editor's headless suite runs with the engine absent — P18 §6, §8.
 *
 * CI's `no-sculptcore` lane deinits the submodule, so "this suite must pass
 * there" is really a claim about a module graph: if nothing the headless UV
 * suites load at runtime lives under `sculptcore/` or a geometry addon,
 * deleting those cannot change the answer. Walking the graph proves that here,
 * on every run, instead of only in the lane — and it fails on the import that
 * breaks it rather than three months later in CI.
 *
 * Type-only imports are followed but not counted: they are erased before
 * anything runs, which is exactly why the editor core is allowed its
 * `import type ... from '@framework/api'`.
 */

import fs from 'node:fs'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = Path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = Path.resolve(HERE, '../../..')
const SUITES = [Path.join(HERE, 'uv_edit_geom.test.ts'), Path.join(HERE, 'uv_solve.test.ts')]
const EDITOR_CORE = Path.join(REPO_ROOT, 'addons/builtin/uv_editor/src/uv_edit_geom.ts')

/** Directories the suite may not reach through a value import, and why. */
const FORBIDDEN_DIRS: [RegExp, string][] = [
  [/^sculptcore\//, 'the engine submodule the no-sculptcore lane deinits'],
  [/^addons\/builtin\/litemesh\//, 'an engine-backed geometry addon'],
  [/^addons\/builtin\/mesh\//, 'an engine-backed geometry addon'],
]

/**
 * Aliases jest does resolve, mirroring `jest.config.ts`'s `moduleNameMapper`.
 * The walk follows them rather than stopping, so what is behind one is held to
 * the same rules as the rest of the graph.
 */
const BARE_ALIASES: Record<string, string> = {
  '@framework/pathux': Path.join(REPO_ROOT, 'tests/lib/pathux_shim.ts'),
}

/** Bare specifiers are all unresolvable under jest; these are the fatal ones. */
const FORBIDDEN_BARE = /^(@sculptcore\/|@builtin\/|@addon\/|@framework\/)/

interface Specifier {
  spec: string
  typeOnly: boolean
}

/**
 * Strip comments, so a doc comment naming a module is not read as importing it.
 * Template literals are left alone: a specifier invented out of one fails to
 * resolve, which the first test reports rather than swallows.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function specifiersOf(file: string): Specifier[] {
  const src = stripComments(fs.readFileSync(file, 'utf-8'))
  const out: Specifier[] = []

  // `import ... from 'x'` / `export ... from 'x'`, with or without a leading
  // `type`. An inline `{type A, B}` counts as a value import — conservative,
  // and the graph is small enough that it costs nothing.
  for (const m of src.matchAll(/(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]/g)) {
    out.push({spec: m[2], typeOnly: !!m[1]})
  }
  // Side-effect import: `import 'x'`.
  for (const m of src.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) {
    out.push({spec: m[1], typeOnly: false})
  }
  return out
}

/**
 * Resolve a relative specifier the way the suite's jest config does — the
 * `.js` suffix the framework writes is stripped so the `.ts` source is found.
 */
function resolveRelative(fromFile: string, spec: string): string | undefined {
  const base = Path.resolve(Path.dirname(fromFile), spec)
  const stems = base.endsWith('.js') ? [base.slice(0, -3), base] : [base]
  for (const stem of stems) {
    for (const cand of [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, Path.join(stem, 'index.ts')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return cand
      }
    }
  }
  return undefined
}

interface Graph {
  files: string[]
  bare: string[]
  unresolved: string[]
}

/** Every file reachable from `roots` through value imports, plus what stayed bare. */
function valueGraph(roots: string[]): Graph {
  const seen = new Set<string>()
  const bare = new Set<string>()
  const unresolved: string[] = []
  const queue = [...roots]

  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) {
      continue
    }
    seen.add(file)

    for (const {spec, typeOnly} of specifiersOf(file)) {
      if (typeOnly) {
        continue
      }
      if (!spec.startsWith('.')) {
        const alias = BARE_ALIASES[spec]
        if (alias === undefined) {
          bare.add(spec)
        } else {
          queue.push(alias)
        }
        continue
      }
      const resolved = resolveRelative(file, spec)
      if (resolved) {
        queue.push(resolved)
      } else {
        unresolved.push(`${Path.relative(REPO_ROOT, file)} -> ${spec}`)
      }
    }
  }
  return {
    files: [...seen].map((f) => Path.relative(REPO_ROOT, f).split(Path.sep).join('/')),
    bare : [...bare],
    unresolved,
  }
}

describe('the UV editor double suites are engine-free', () => {
  const graph = valueGraph(SUITES)

  test('every value import resolves, so the walk is not silently short', () => {
    expect(graph.unresolved).toEqual([])
    // The suites, the editor core, the solvers, the double and the contract. A
    // resolver that stopped at the first file would pass every other assertion
    // here.
    expect(graph.files.length).toBeGreaterThanOrEqual(8)
    expect(graph.files).toContain('addons/builtin/uv_editor/src/uv_edit_geom.ts')
    expect(graph.files).toContain('addons/builtin/uv_editor/src/uv_solve.ts')
    expect(graph.files).toContain('addons/builtin/uv_editor/src/uv_wrangler.ts')
    expect(graph.files).toContain('scripts/core/geometry_contract.ts')
    // And through the alias, or the rule below would never see path.ux at all.
    expect(graph.files).toContain('tests/lib/pathux_shim.ts')
    expect(graph.files).toContain('scripts/path.ux/scripts/path-controller/util/solver.ts')
  })

  test('nothing it loads lives under the engine or a geometry addon', () => {
    for (const [dir, why] of FORBIDDEN_DIRS) {
      const hits = graph.files.filter((f) => dir.test(f))
      if (hits.length) {
        // eslint-disable-next-line no-console
        console.error(`[uv-editor] reaches ${why}:\n  ${hits.join('\n  ')}`)
      }
      expect(hits).toEqual([])
    }
  })

  test('no value import needs a bundler alias jest cannot resolve', () => {
    expect(graph.bare.filter((s) => FORBIDDEN_BARE.test(s))).toEqual([])
  })

  test('the editor core takes the host as types only', () => {
    const host = specifiersOf(EDITOR_CORE).filter((s) => s.spec.startsWith('@framework/'))
    expect(host.length).toBeGreaterThan(0)
    expect(host.filter((s) => !s.typeOnly)).toEqual([])
  })
})
