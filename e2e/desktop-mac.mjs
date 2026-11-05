// End-to-end test of the RastaVec desktop app on macOS.
//
// WKWebView cannot be driven over CDP, so the test variant of the app is built with
// VITE_E2E_PORT: an in-app harness (src/lib/e2e-harness.ts) drives the real UI and
// reports each step to this local server, which takes a screenshot (screencapture)
// before answering. Results are checked here, like the Windows test.
//
// Usage: node desktop-mac.mjs --app <path/to/rastavec> --images <a.png,b.png> --out <dir> [--port 9555]

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true])
    return acc
  }, []),
)
const APP = args.app
const IMAGES = String(args.images ?? '').split(',').filter(Boolean).map((p) => resolve(p))
const OUT = resolve(args.out ?? 'e2e-out')
const PORT = Number(args.port ?? 9555)
const MAX_DIFF = Number(args['max-diff'] ?? 5)
const TIMEOUT_S = Number(args.timeout ?? 240)

if (!APP || !IMAGES.length) {
  console.error('usage: node desktop-mac.mjs --app <binary> --images <a.png,b.png> --out <dir>')
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const checks = []
const steps = []
const t0 = Date.now()
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${elapsed()}] ${name}${detail ? ` — ${detail}` : ''}`)
}
function screenshot(name) {
  const file = join(OUT, `${String(steps.length + 1).padStart(2, '0')}-${name}.png`)
  const r = spawnSync('screencapture', ['-x', '-t', 'png', file])
  console.log(`  step ${name}${r.status === 0 ? ` → ${basename(file)}` : ' (screenshot failed)'}`)
  steps.push(name)
}

let finish
const done = new Promise((r) => (finish = r))
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
const server = createServer((req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { ...cors, 'content-type': type })
    res.end(body)
  }
  if (req.method === 'OPTIONS') return send(204, '')
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (req.method === 'GET' && url.pathname === '/images') return send(200, JSON.stringify({ images: IMAGES.map((p) => basename(p)) }))
  if (req.method === 'GET' && url.pathname.startsWith('/images/')) {
    const name = decodeURIComponent(url.pathname.slice(8))
    const file = IMAGES.find((p) => basename(p) === name)
    return file ? send(200, readFileSync(file), 'image/png') : send(404, '{}')
  }
  if (req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const msg = body ? JSON.parse(body) : {}
      if (url.pathname === '/step') {
        if (!steps.length) check('App starts and the harness reports back', true)
        screenshot(msg.name)
        return send(200, '{}')
      }
      if (url.pathname === '/done') {
        send(200, '{}')
        return finish(msg)
      }
      send(404, '{}')
    })
    return
  }
  send(404, '{}')
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log(`harness server on http://127.0.0.1:${PORT}`)

const app = spawn(APP, [], { stdio: ['ignore', 'inherit', 'inherit'] })
let exited = null
app.on('exit', (code) => {
  exited = code
  console.log(`app exited with code ${code}`)
})
const timer = setTimeout(() => finish({ error: `no result from the app within ${TIMEOUT_S}s (steps: ${steps.join(', ') || 'none'})` }), TIMEOUT_S * 1000)
const result = await done
clearTimeout(timer)

if (!steps.length && !result.error?.startsWith?.('no result')) check('App starts and the harness reports back', false)
if (result.error) {
  if (!steps.length) screenshot('failure')
  check('Harness ran without error', false, result.error)
}
if (result.logo !== undefined) check('Home screen renders (logo loaded)', result.logo, result.userAgent ?? '')
if (result.imported) check('Images imported', true, result.imported)
for (const it of result.items ?? []) {
  const last = String(it.diffText).split('→').pop().trim()
  const pct = /\d\s*%$/.test(last) ? Number(last.replace(/[^\d.,]/g, '').replace(',', '.')) : NaN
  check(`${it.name}: vectorised`, it.done, it.status)
  check(`${it.name}: SVG renders`, it.svgRendered)
  check(`${it.name}: difference ≤ ${MAX_DIFF}%`, Number.isFinite(pct) && pct <= MAX_DIFF, `${it.diffText} · ${it.iou} · ${it.size}`)
}
if (result.detail) check('Detail view shows metrics', Object.keys(result.detail).length >= 3, JSON.stringify(result.detail))
if (result.slider !== undefined) check('Comparison slider responds to the keyboard', result.slider !== null && Number(result.slider) < 50, `aria-valuenow=${result.slider}`)
if (result.consoleErrors) {
  const wasm = result.consoleErrors.filter((e) => /wasm|webassembly|vtracer/i.test(e))
  check('No WebAssembly errors in the console', wasm.length === 0, wasm.slice(0, 3).join(' | '))
}
if (!result.items?.length && !result.error) check('Vectorisation results received', false)

const failed = !checks.length || checks.some((c) => !c.ok)
const report = { app: APP, images: IMAGES.map((p) => basename(p)), maxDiff: MAX_DIFF, ok: !failed, seconds: Math.round((Date.now() - t0) / 100) / 10, checks, steps, result }
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    `## RastaVec desktop (macOS) — end-to-end test ${failed ? '❌' : '✅'}`,
    '',
    `Test variant of the app driven by its in-app harness (WKWebView), ${report.seconds}s. Screenshots and report.json are in the **e2e-desktop-macos** artifact.`,
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${c.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)} |`),
    '',
    ...((result.items ?? []).length
      ? ['| Image | Status | Difference | IoU | Size |', '|---|---|---|---|---|', ...result.items.map((i) => `| ${i.name} | ${i.status} | ${i.diffText} | ${i.iou} | ${i.size} |`)]
      : []),
    '',
  ].join('\n')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
}

if (exited === null) app.kill('SIGKILL')
server.close()
console.log(failed ? 'E2E FAILED' : 'E2E PASSED')
process.exit(failed ? 1 : 0)
