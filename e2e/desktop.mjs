// End-to-end test of the installed RastaVec desktop app on Windows.
//
// The app runs in WebView2 (Chromium), started with a remote debugging port so
// Playwright can drive the real window over CDP: import images, vectorise them,
// open the detail view, then check the metrics. Screenshots, an optional screen
// recording, a JSON report and a GitHub job summary are written to --out.
//
// Usage: node desktop.mjs --app <RastaVec.exe> --images <a.png,b.png> --out <dir> [--video]

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true])
    return acc
  }, []),
)
const APP = args.app
const IMAGES = String(args.images ?? '').split(',').filter(Boolean).map((p) => resolve(p))
const OUT = resolve(args.out ?? 'e2e-out')
const PORT = 9222
// Max share of visibly different pixels per image (same scale as the app and the CLI).
const MAX_DIFF = Number(args['max-diff'] ?? 5)

if (!APP || !IMAGES.length) {
  console.error('usage: node desktop.mjs --app <exe> --images <a.png,b.png> --out <dir> [--video]')
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const checks = []
const consoleErrors = []
let shot = 0
const t0 = Date.now()
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${elapsed()}] ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

async function snap(page, name) {
  const file = join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  screenshot ${basename(file)}`)
  return file
}

// Optional screen recording of the whole desktop (ffmpeg gdigrab).
let recorder = null
function startVideo() {
  if (!args.video) return
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', shell: true })
  if (probe.status !== 0) return console.log('ffmpeg not found: no video')
  recorder = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '8', '-i', 'desktop',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    join(OUT, 'session.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] })
  console.log('recording desktop to session.mp4')
}
async function stopVideo() {
  if (!recorder) return
  recorder.stdin.write('q')
  await Promise.race([new Promise((r) => recorder.on('exit', r)), sleep(15000)])
}

async function waitForCdp(timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return await r.json()
    } catch {}
    await sleep(500)
  }
  // Diagnostics: what WebView2 was actually started with, and what listens.
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Select-Object -First 3 -ExpandProperty CommandLine; netstat -ano | findstr LISTENING | findstr 127.0.0.1"],
    { encoding: 'utf8' })
  console.log(ps.stdout, ps.stderr)
  throw new Error(`WebView2 debugging port ${PORT} did not open within ${timeoutMs / 1000}s`)
}

const report = { app: APP, images: IMAGES.map((p) => basename(p)), maxDiff: MAX_DIFF, checks, items: [], detail: null, consoleErrors }
let app = null
let browser = null
let failed = false

try {
  startVideo()

  // 1. Launch the installed app with a debugging port on its WebView2.
  app = spawn(APP, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: 'ignore',
  })
  app.on('exit', (code) => console.log(`app exited with code ${code}`))
  const version = await waitForCdp(60000)
  check('App starts and WebView2 is reachable', true, version.Browser)

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const context = browser.contexts()[0]
  // Wait for the app page itself (tauri.localhost), not a blank or devtools target.
  let page = null
  for (let end = Date.now() + 30000; !page && Date.now() < end; await sleep(500)) {
    page = context.pages().find((p) => /tauri\.localhost|^tauri:/.test(p.url())) ?? null
  }
  if (!page) throw new Error(`App page not found: ${context.pages().map((p) => p.url()).join(', ')}`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('header img.logo', { timeout: 30000 })
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {})

  // Force English so the report and screenshots are stable.
  await page.evaluate(() => localStorage.setItem('rastavec.locale', 'en'))
  await page.reload()
  await page.waitForSelector('header img.logo', { timeout: 30000 })
  const logoOk = await page.$eval('header img.logo', (img) => img.complete && img.naturalWidth > 0)
  check('Home screen renders (logo loaded)', logoOk, page.url())
  await snap(page, 'import')

  // 2. Import images through the real file input.
  const input = page.locator('input[type=file][multiple]:not([webkitdirectory])')
  await input.setInputFiles(IMAGES)
  const cta = page.locator('button.cta')
  await page.waitForFunction(() => !document.querySelector('button.cta')?.disabled, null, { timeout: 30000 })
  check('Images imported', true, (await cta.innerText()).trim())
  await sleep(1500) // let the analysis badges settle for the screenshot
  await snap(page, 'imported')

  // 3. Vectorise (WebAssembly VTracer inside the desktop WebView).
  await cta.click()
  await page.waitForSelector('.tile', { timeout: 30000 })
  const n = IMAGES.length
  await page.waitForFunction(
    (n) => {
      const tiles = [...document.querySelectorAll('.tile')]
      return tiles.length === n && tiles.every((t) => !t.disabled || t.querySelector('.chip')?.textContent?.match(/error|erreur/i))
    },
    n,
    { timeout: 300000, polling: 1000 },
  )
  await page.waitForSelector('.exportbar', { timeout: 30000 })

  const items = await page.$$eval('.tile', (tiles) =>
    tiles.map((t) => {
      const vec = t.querySelector('img.vec')
      const diff = t.querySelector(':scope > .stack .between .mono')?.textContent ?? ''
      const last = diff.split('→').pop().trim()
      // Only accept an actual percentage, so a wrong selector can never pass silently.
      const pct = /\d\s*%$/.test(last) ? Number(last.replace(/[^\d.,]/g, '').replace(',', '.')) : NaN
      const foot = [...t.querySelectorAll(':scope > .between.mono span')].map((s) => s.textContent.trim())
      return {
        name: t.querySelector('.nm')?.textContent?.trim(),
        status: t.querySelector('.chip')?.textContent?.trim(),
        done: !t.disabled,
        svgRendered: Boolean(vec && vec.complete && vec.naturalWidth > 0),
        diffText: diff.trim(),
        pctDiff: pct,
        iou: foot[0] ?? '',
        size: foot[1] ?? '',
      }
    }),
  )
  report.items = items
  await snap(page, 'batch')
  for (const it of items) {
    check(`${it.name}: vectorised`, it.done, it.status)
    check(`${it.name}: SVG renders`, it.svgRendered)
    check(`${it.name}: difference ≤ ${MAX_DIFF}%`, Number.isFinite(it.pctDiff) && it.pctDiff <= MAX_DIFF, `${it.diffText} · ${it.iou} · ${it.size}`)
  }

  // 4. Detail view: comparison slider and metrics.
  await page.locator('.tile:not([disabled])').first().click()
  await page.waitForSelector('dl.metrics', { timeout: 30000 })
  await sleep(800)
  const detail = await page.$$eval('dl.metrics dt', (dts) => Object.fromEntries(dts.map((dt) => [dt.textContent.trim(), dt.nextElementSibling?.textContent.trim()])))
  report.detail = detail
  check('Detail view shows metrics', Object.keys(detail).length >= 3, JSON.stringify(detail))
  await snap(page, 'detail')

  const slider = page.locator('[role=slider]').first()
  if (await slider.count()) {
    await slider.focus()
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
    const v = await slider.getAttribute('aria-valuenow')
    check('Comparison slider responds to the keyboard', v !== null && Number(v) < 50, `aria-valuenow=${v}`)
    await snap(page, 'detail-slider')
  }

  const wasmErrors = consoleErrors.filter((e) => /wasm|webassembly|vtracer/i.test(e))
  check('No WebAssembly errors in the console', wasmErrors.length === 0, wasmErrors.slice(0, 3).join(' | '))
} catch (err) {
  check('Unexpected error', false, err?.stack ?? err)
  try {
    const page = browser?.contexts()[0]?.pages()[0]
    if (page) await snap(page, 'failure')
  } catch {}
} finally {
  failed = checks.some((c) => !c.ok)
  report.ok = !failed
  report.seconds = Math.round((Date.now() - t0) / 100) / 10
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `## RastaVec desktop — end-to-end test ${failed ? '❌' : '✅'}`,
      '',
      `Installed app driven through WebView2 (Playwright over CDP), ${report.seconds}s. Screenshots${recorder ? ', video' : ''} and report.json are in the **rastavec-desktop-e2e** artifact.`,
      '',
      '| Check | Result | Detail |',
      '|---|---|---|',
      ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${c.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)} |`),
      '',
      ...(report.items.length
        ? ['| Image | Status | Difference | IoU | Size |', '|---|---|---|---|---|', ...report.items.map((i) => `| ${i.name} | ${i.status} | ${i.diffText} | ${i.iou} | ${i.size} |`)]
        : []),
      '',
    ].join('\n')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
  }

  await browser?.close().catch(() => {})
  if (app && app.exitCode === null) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  await stopVideo()
  console.log(failed ? 'E2E FAILED' : 'E2E PASSED')
  process.exit(failed ? 1 : 0)
}
