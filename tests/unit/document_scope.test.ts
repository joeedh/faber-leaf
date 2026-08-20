/**
 * P20 §2.6: the app does not own the document.
 *
 * `mountFaberLeaf` puts an instance inside a container, so a fixed-id lookup
 * (`document.getElementById('webgl')`, `#iconsheet`, …) is a bug the moment a
 * second instance mounts — both would find the first one's element. Host code
 * therefore reaches its DOM through the instance (`state.container`,
 * `state.glCanvas`), never through the document.
 *
 * The one exemption is the mount bootstrap itself: setup_pathux resolves the
 * process-wide icon sheet from the host page when the embedder supplies no
 * URL, which is what the NW.js shell relies on. See
 * documentation/plans/2026-08-15-0435-w5-deglobalize-embedding-api.md §2.6.
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Vendored or submodule trees with their own rules. */
const SKIP_DIRS = new Set(['path.ux', 'mathl', 'extern', 'node_modules', 'build'])

/** The mount bootstrap, allowed to read the host page. */
const EXEMPT_FILES = new Set(['scripts/setup_pathux.js'])

const LOOKUP = /document\s*\.\s*(getElementById|querySelector|querySelectorAll)\s*\(/

function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(REPO_ROOT, dir)
  if (!fs.existsSync(abs)) {
    return out
  }

  for (const entry of fs.readdirSync(abs, {withFileTypes: true})) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(rel, out)
      }
    } else if (/\.(ts|tsx|js)$/.test(entry.name)) {
      out.push(rel)
    }
  }

  return out
}

/** Line-comment / block-comment-only lines don't count. */
function isCommented(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line)
}

test('host code looks up DOM through the instance, not the document', () => {
  const offenders: string[] = []

  for (const rel of walk('scripts')) {
    if (EXEMPT_FILES.has(rel)) {
      continue
    }

    const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (LOOKUP.test(line) && !isCommented(line)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
      }
    })
  }

  expect(offenders).toEqual([])
})
