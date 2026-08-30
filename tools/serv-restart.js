/* eslint-disable no-console */
/**
 * Kill any process listening on the dev server port, then spawn a
 * fresh detached `serv.js` and exit. Lets `pnpm serv:restart` cycle
 * the server without leaving a foreground process attached to the
 * caller's terminal.
 */

import {execSync, spawn} from 'child_process'
import path from 'path'
import {fileURLToPath} from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const argPort = process.argv.length > 2 && !isNaN(parseInt(process.argv[2])) ? parseInt(process.argv[2]) : undefined
const envPort = process.env['SERVER_PORT']?.length ? parseInt(process.env['SERVER_PORT']) : undefined
const PORT = argPort ?? envPort ?? 5007

function pidsListeningOn(port) {
  const pids = new Set()
  try {
    if (process.platform === 'win32') {
      // Plain `netstat -ano` — adding `-p TCP` filters out IPv6
      // LISTENING entries on Windows 11, which is exactly where
      // `node` binds when serv.js uses host `localhost`.
      const out = execSync('netstat -ano', {encoding: 'utf8'})
      for (const line of out.split(/\r?\n/)) {
        // Columns: proto, local, foreign, state, pid. The local
        // address may be IPv6 (`[::1]:5007`), so just take the
        // last `:`-delimited segment for the port — a regex would
        // otherwise misfire on the `:1` inside `[::1]`.
        const cols = line.trim().split(/\s+/)
        if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
        const localPort = parseInt(cols[1].split(':').pop())
        if (localPort === port) pids.add(cols[4])
      }
    } else {
      try {
        const out = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN`, {encoding: 'utf8'})
        for (const pid of out.split(/\s+/).filter(Boolean)) pids.add(pid)
      } catch {
        // lsof returns nonzero when nothing matches — not an error.
      }
    }
  } catch (err) {
    console.warn(`[serv:restart] could not scan listening ports: ${err.message}`)
  }
  return [...pids]
}

const pids = pidsListeningOn(PORT)
for (const pid of pids) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, {stdio: 'ignore'})
    } else {
      execSync(`kill -9 ${pid}`, {stdio: 'ignore'})
    }
    console.log(`[serv:restart] killed pid ${pid} (was on :${PORT})`)
  } catch (err) {
    console.warn(`[serv:restart] failed to kill pid ${pid}: ${err.message}`)
  }
}

const servPath = path.join(__dirname, 'serv.js')
const child = spawn(process.execPath, [servPath, String(PORT)], {
  detached: true,
  stdio   : 'ignore',
  cwd     : path.resolve(__dirname, '..'),
})
child.unref()

console.log(`[serv:restart] spawned detached server (pid ${child.pid}) on :${PORT}`)
