// Exercise the experimental frontend in a real Windows Tauri debug executable.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const [input, destination = 'output/vtracer-next-desktop'] = process.argv.slice(2)
assert(input, 'Usage: node e2e/vtracer-desktop-smoke.mjs <image.png> [output-directory]')
assert(process.platform === 'win32', 'This smoke test uses Windows WebView2.')
const out = resolve(destination)
await mkdir(out, { recursive: true })
const frontend = 'http://localhost:5179/'
const server = await preview({
  build: { outDir: resolve('output/vtracer-next-web-final') },
  preview: { host: 'localhost', port: 5179, strictPort: true },
})
const cdp = 'http://127.0.0.1:9237'
const executable = resolve('src-tauri/target/debug/rastavec.exe')
let app
let browser
try {
  app = spawn(executable, [], {
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9237',
      WEBVIEW2_USER_DATA_FOLDER: resolve(out, 'webview2'),
    },
  })
  let launchError
  let connectionError
  app.on('error', (error) => { launchError = error })
  const deadline = Date.now() + 45_000
  while (!browser && Date.now() < deadline) {
    if (launchError) throw launchError
    if (app.exitCode !== null) throw new Error(`Tauri exited with code ${app.exitCode}`)
    try {
      browser = await chromium.connectOverCDP(cdp, { timeout: 2000 })
    } catch (error) {
      connectionError = error
      await delay(500)
    }
  }
  assert(browser, `Tauri WebView2 connection failed: ${connectionError?.message ?? 'No response'}`)
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? await context.waitForEvent('page')
  const initialUrl = page.url()
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto(frontend, { waitUntil: 'domcontentloaded' })
  await page.locator('#experimental-gradients').waitFor()
  assert(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)), 'Expected the Tauri window.')
  await page.evaluate(() => localStorage.setItem('rastavec.locale', 'en'))
  await page.reload()
  await page.locator('#experimental-gradients').check()
  await page.locator('.preset').filter({ has: page.getByText('Shaded illustration', { exact: true }) }).click()
  const autoTune = page.locator('button.toggle')
  if (await autoTune.getAttribute('aria-pressed') === 'true') await autoTune.click()
  await page.locator('#ld').fill('12')
  await page.locator('#sp').fill('0')
  await page.locator('input[type=file][multiple]:not([webkitdirectory])').setInputFiles(resolve(input))
  await page.locator('button.cta').click()
  await page.locator('.exportbar').waitFor({ timeout: 90_000 })
  await page.locator('.tile').click()
  const download = page.waitForEvent('download', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Download SVG', exact: true }).click()
  const svgPath = resolve(out, 'export.svg')
  await (await download).saveAs(svgPath)
  const svg = await readFile(svgPath, 'utf8')
  const counts = await page.evaluate((xml) => {
    const doc = new DOMParser().parseFromString(xml, 'image/svg+xml')
    if (doc.querySelector('parsererror')) throw new Error('Exported SVG is invalid.')
    return { gradients: doc.querySelectorAll('linearGradient, radialGradient').length, stops: doc.querySelectorAll('stop').length }
  }, svg)
  assert(counts.gradients > 0 && counts.stops >= 2, 'Expected editable gradient stops in the export.')
  await page.screenshot({ path: resolve(out, 'desktop.png') })
  const report = { executable, initialUrl, frontend, input: resolve(input), engine: 'next-gradients', svgPath, bytes: Buffer.byteLength(svg), ...counts }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  await writeFile(resolve(out, 'failure.txt'), String(error.stack ?? error) + '\n')
  throw error
} finally {
  await browser?.close().catch(() => {})
  app?.kill()
  await server.close()
}
