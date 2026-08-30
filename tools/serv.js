/* eslint-disable no-console */
import fs from 'fs'
import http from 'http'
import path from 'path'

// set by devconainer
const argPort = process.argv.length > 2 && !isNaN(parseInt(process.argv[2])) ? parseInt(process.argv[2]) : undefined
const envPort = process.env['SERVER_PORT']?.length ? parseInt(process.env['SERVER_PORT']) : undefined

const SERVER_HOST = (process.env['SERVER_HOST'] ?? '').trim()

const PORT = argPort ?? envPort ?? 5007
const HOST = SERVER_HOST.length > 0 ? SERVER_HOST : 'localhost'

const INDEX = 'index.html'
const basedir = process.cwd()

export const exports = {}

let mimemap = {
  '.js'  : 'application/javascript',
  '.cjs' : 'application/javascript',
  '.mjs' : 'application/javascript',
  '.ts'  : 'application/typescript',
  '.json': 'text/json',
  '.html': 'text/html',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.css' : 'text/css',
  '.svg' : 'image/svg+xml',
  '.wasm': 'application/wasm',
}

let getMime = (p) => {
  p = p.toLowerCase().trim()

  for (let k in mimemap) {
    if (p.endsWith(k)) {
      return mimemap[k]
    }
  }

  return 'text/plain'
}

let allowed_origins = new Set([`http://${HOST}:${PORT}/`, `http://${HOST}:${PORT}`])

exports.ServerResponse = class ServerResponse extends http.ServerResponse {
  _addHeaders(origin = globalThis.ORIGIN) {
    this.setHeader('X-Content-Type-Options', 'nosniff')

    if (true) {
      //allowed_origins.has(origin)) {
      this.setHeader('Access-Control-Allow-Origin', origin)
    }

    this.setHeader('Document-Policy', 'js-profiling')
    this.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    this.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    this.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    this.setHeader('Vary', 'Origin')
  }

  sendError(code, message) {
    let buf = `<!doctype html>
<html>
<head><title>404</title></head>
<body><div>${message}<div><body>
</html>
`

    this.statusCode = code
    this.setHeader('Host', HOST)
    this.setHeader('Content-Type', 'text/html')
    this.setHeader('Content-Length', buf.length)
    this._addHeaders()

    this.writeHead(code)
    this.end(buf)
  }
}

const serv = http.createServer(
  {
    ServerResponse: exports.ServerResponse,
  },
  (req, res) => {
    let p = req.url.trim()

    if (!p.startsWith('/')) {
      p = '/' + p
    }

    // Strip query string and fragment — they're meaningful to the
    // client (e.g. `?renderer=webgpu` is read by renderer_flag.ts) but
    // would otherwise end up in the filesystem path and 404.
    const qidx = p.search(/[?#]/)
    if (qidx >= 0) p = p.slice(0, qidx)

    // Percent-decode so paths with spaces/special chars (e.g.
    // "/examples/sculpt%20test.wproj") map to the real filename. The
    // `..` traversal guard below runs on the decoded+normalized path.
    try {
      p = decodeURIComponent(p)
    } catch {
      return res.sendError(400, 'malformed path encoding')
    }

    globalThis.ORIGIN = req.headers['origin'] ?? '*' //Boolean(origin.trim().length) ? origin : undefined

    console.log(req.method, p, ORIGIN)

    if (p === '/') {
      p += INDEX
    }

    p = path.normalize(basedir + p)
    if (p.search(/\.\./) >= 0 || !p.startsWith(basedir)) {
      //normalize failed
      return res.sendError(500, 'malformed path')
    }

    let stt
    try {
      stt = fs.statSync(p)
    } catch (error) {
      return res.sendError(404, 'bad path ' + p)
    }

    if (stt === undefined || stt.isDirectory() || !stt.isFile()) {
      console.log('access error for', p)
      return res.sendError(404, 'invalid path ' + p)
    }

    let mime = getMime(p)

    let buf = fs.readFileSync(p)

    res.statusCode = 200
    res.setHeader('Content-Type', mime)
    res._addHeaders()
    res.writeHead(200)
    res.end(buf)
  }
)

serv.listen(PORT, HOST, () => {
  console.log('Server listening on', 'http://' + HOST + ':' + PORT)
})
