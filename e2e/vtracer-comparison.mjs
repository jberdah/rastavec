// Run against the local web app; VTracer-Next is the only tracing engine.
// npm ci --prefix e2e
// node e2e/vtracer-comparison.mjs --app http://127.0.0.1:4173
// Add --serve to start Vite in the harness process, or --dist <dir> to preview a built app.
// Use --prepare-only to generate input PNGs and their provenance without an app.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corpus = 'crates/vtracer/tests/data/'
const openclipart = 'gradients-openclipart/'
const fixtures = [
  { id: 'rainbow', title: 'Saturated six-stop rainbow', file: openclipart + 'rainbow-saturated.svg', artist: 'Manuela', license: 'CC0-1.0', source: 'https://openclipart.org/detail/294323/rainbow-gradient-with-saturated-colors' },
  { id: 'alpha-shadow', title: 'Isolated alpha shadow', file: 'gradient-hard-cases/openclipart-333901-alpha-shadow.svg', artist: 'Highlander', license: 'CC0-1.0', source: 'https://openclipart.org/333901/mafioso-pinguin', note: 'The sibling corpus isolates the authored shadow path and its two alpha stops.' },
  { id: 'conic', title: 'Conic gradient (2025)', file: openclipart + 'conic-gradient-2025.svg', artist: 'Lazur', license: 'CC0-1.0', source: 'https://openclipart.org/detail/352954/conic-gradient' },
  { id: 'spiral', title: 'Gradient spiral', file: openclipart + 'gradient-spiral.svg', artist: 'Lazur', license: 'CC0-1.0', source: 'https://openclipart.org/detail/352913/gradient-spiral', note: 'The source has already expanded the bent gradient into many small paths.' },
  { id: 'spiral-preview', title: 'Animated spiral, published static preview', file: openclipart + 'spiral-gradient-animated-official-preview.png', artist: 'Lazur', license: 'CC0-1.0', source: 'https://openclipart.org/detail/350683/spiral-gradient-animated', rasterSource: 'https://openclipart.org/image/2000px/350683' },
  { id: 'logo', title: 'RastaVec logo', file: 'assets/rastavec-logo.png', project: true, source: 'https://github.com/jberdah/rastavec/blob/main/assets/rastavec-logo.png' },
]

const engines = ['next', 'next-gradients']
const presets = { shaded: 'Shaded illustration', auto: 'Auto', flat: 'Flat logo', 'gradient-probe': 'Shaded illustration' }
const { values: args } = parseArgs({ options: {
  app: { type: 'string', default: 'http://127.0.0.1:4173' },
  fork: { type: 'string', default: join(root, '..', 'VTracer-next') },
  out: { type: 'string', default: join(root, 'output', 'vtracer-comparison') },
  cases: { type: 'string', default: fixtures.map(({ id }) => id).join(',') },
  modes: { type: 'string', default: engines.join(',') },
  sizes: { type: 'string', default: '256' },
  repeats: { type: 'string', default: '3' },
  preset: { type: 'string', default: 'shaded' },
  channel: { type: 'string', default: 'chrome' },
  executable: { type: 'string' },
  serve: { type: 'boolean' },
  dist: { type: 'string' },
  'prepare-only': { type: 'boolean' },
} })

const appUrl = new URL(args.app)
assert(appUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname), 'Use a local HTTP app URL')
const selectedCases = args.cases.split(',').map((id) => {
  const fixture = fixtures.find((entry) => entry.id === id)
  assert(fixture, `Unknown case ${id}`)
  return fixture
})
const sizes = args.sizes.split(',').map(Number)
const selectedEngines = args.modes.split(',')
const repeats = Number(args.repeats)
assert(sizes.every((size) => Number.isInteger(size) && size >= 32 && size <= 2048), 'Use --sizes with comma-separated lengths from 32 to 2048')
assert(selectedEngines.every((engine) => engines.includes(engine)), `Available modes: ${engines.join(', ')}`)
assert(Number.isInteger(repeats) && repeats > 0, 'Use a positive integer for --repeats')
assert(Object.hasOwn(presets, args.preset), `Available presets: ${Object.keys(presets).join(', ')}`)
assert(!(args.serve && args.dist), 'Use either --serve or --dist')
const out = resolve(args.out)
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const revision = (cwd) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
const workingTree = () => execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trimEnd().split(/\r?\n/).filter(Boolean)
const dataUrl = (data, mime) => `data:${mime};base64,${data.toString('base64')}`
const pngBytes = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')

async function makeInput(page, fixture, maxSide) {
  const repo = fixture.project ? root : resolve(args.fork)
  const file = fixture.project ? fixture.file : corpus + fixture.file
  const source = await readFile(join(repo, file))
  const isSvg = file.endsWith('.svg')
  const generated = await page.evaluate(async ({ url, isSvg, maxSide }) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const scale = maxSide / Math.max(image.naturalWidth, image.naturalHeight)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    if (isSvg) {
      const svg = new DOMParser().parseFromString(await (await fetch(url)).text(), 'image/svg+xml').documentElement
      if (!svg.hasAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${image.naturalWidth} ${image.naturalHeight}`)
      svg.setAttribute('width', width)
      svg.setAttribute('height', height)
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
      await image.decode()
    }
    const canvas = Object.assign(document.createElement('canvas'), { width, height })
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, width, height)
    const pixels = ctx.getImageData(0, 0, width, height).data
    let visible = 0
    let soft = 0
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 0) visible++
      if (pixels[i] > 0 && pixels[i] < 255) soft++
    }
    return { width, height, visible, soft, png: canvas.toDataURL() }
  }, { url: dataUrl(source, isSvg ? 'image/svg+xml' : 'image/png'), isSvg, maxSide })
  assert(generated.visible > 0, `Empty input raster for ${fixture.id}`)
  const { png, ...info } = generated
  const data = pngBytes(png)
  const stem = `${fixture.id}-${maxSide}`
  const path = join('inputs', `${stem}.png`)
  await writeFile(join(out, path), data)
  return {
    id: fixture.id, title: fixture.title, stem, maxSide, path, ...info, sha256: sha256(data),
    provenance: { ...fixture, file, revision: revision(repo), sha256: sha256(source),
      transform: isSvg ? 'Chromium SVG image with aspect-preserving viewport resize' : 'Chromium canvas resize, high smoothing' },
  }
}

async function engineArtifacts() {
  const files = [
    'scripts/build-vtracer-next.sources.json',
    'src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm',
  ]
  return Object.fromEntries(await Promise.all(files.map(async (file) => {
    const bytes = await readFile(join(root, file)).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    return [file, bytes && sha256(bytes)]
  })))
}

async function buildArtifacts(dist) {
  const assets = await readdir(join(dist, 'assets'))
  const files = ['index.html', ...assets
    .filter((file) => /^(index-.*\.js|vtracer.*\.(js|wasm)|vectorization-worker-.*\.js)$/.test(file))
    .map((file) => `assets/${file}`)]
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha256(await readFile(join(dist, file)))])))
}

async function compare(page, input, svg) {
  const reference = await readFile(join(out, input.path))
  return page.evaluate(async ({ source, svg, width, height }) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('Invalid exported SVG')
    const ids = new Set([...doc.querySelectorAll('[id]')].map((el) => el.id))
    const brokenReferences = new Set()
    const gradientPaints = new Set()
    let gradientPaintUses = 0
    for (const element of doc.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        const urls = [...attr.value.matchAll(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g)].map((match) => match[1])
        const refs = attr.localName === 'href' && attr.value.startsWith('#') ? [attr.value.slice(1), ...urls] : urls
        for (const id of refs) if (!ids.has(id)) brokenReferences.add(id)
        for (const id of urls) {
          if (!['linearGradient', 'radialGradient'].includes(doc.getElementById(id)?.localName)) continue
          gradientPaints.add(id)
          gradientPaintUses++
        }
      }
    }
    const linearGradients = doc.querySelectorAll('linearGradient').length
    const radialGradients = doc.querySelectorAll('radialGradient').length
    const alphaStops = [...doc.querySelectorAll('stop[stop-opacity]')].filter((stop) => Number(stop.getAttribute('stop-opacity')) < 1).length
    const canvas = Object.assign(document.createElement('canvas'), { width, height })
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    async function pixels(url) {
      const img = new Image()
      img.src = url
      await img.decode()
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      return ctx.getImageData(0, 0, width, height).data
    }
    const src = await pixels(source)
    const actual = await pixels(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    let alpha = 0, softPixels = 0, intersection = 0, union = 0
    let premultiplied = 0, white = 0, dark = 0, opaqueOverlap = 0, opaqueOverlapPixels = 0
    for (let i = 0; i < src.length; i += 4) {
      const srcAlpha = src[i + 3]
      const actualAlpha = actual[i + 3]
      const deltaAlpha = (srcAlpha - actualAlpha) / 255
      alpha += Math.abs(srcAlpha - actualAlpha)
      if (actualAlpha > 0 && actualAlpha < 255) softPixels++
      if (srcAlpha >= 16 && actualAlpha >= 16) intersection++
      if (srcAlpha >= 16 || actualAlpha >= 16) union++
      const opaque = srcAlpha === 255 && actualAlpha === 255
      if (opaque) opaqueOverlapPixels++
      for (let c = 0; c < 3; c++) {
        const delta = (src[i + c] * srcAlpha - actual[i + c] * actualAlpha) / 255
        premultiplied += delta ** 2
        white += (delta - 255 * deltaAlpha) ** 2
        dark += (delta - 32 * deltaAlpha) ** 2
        if (opaque) opaqueOverlap += (src[i + c] - actual[i + c]) ** 2
      }
    }
    const count = width * height
    const rmse = (sum) => Math.sqrt(sum / (3 * count))
    return {
      paths: doc.querySelectorAll('path').length, linearGradients, radialGradients, alphaStops,
      gradientPaints: gradientPaints.size, gradientIds: [...gradientPaints], gradientPaintUses, brokenReferences: [...brokenReferences],
      embeddedImages: doc.querySelectorAll('image').length, softPixels, alphaMae: alpha / count,
      alphaUnionPixels: union,
      alphaIoU16: union ? intersection / union : null, premultipliedRmse: rmse(premultiplied),
      whiteRmse: rmse(white), darkRmse: rmse(dark), opaqueOverlapPixels,
      opaqueOverlapRmse: opaqueOverlapPixels ? Math.sqrt(opaqueOverlap / (3 * opaqueOverlapPixels)) : null,
      png: canvas.toDataURL(),
    }
  }, { source: dataUrl(reference, 'image/png'), svg, width: input.width, height: input.height })
}

async function editGradientStop(page, input, svg, gradientId, dir, originalRender) {
  const edit = await page.evaluate(({ svg, gradientId }) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const stop = doc.getElementById(gradientId)?.querySelector('stop')
    if (!stop) return null
    const before = stop.getAttribute('stop-color')
    const after = before === '#ff00ff' ? '#00ff00' : '#ff00ff'
    stop.setAttribute('stop-color', after)
    return { before, after, offset: stop.getAttribute('offset'), svg: new XMLSerializer().serializeToString(doc) }
  }, { svg, gradientId })
  if (!edit) return null
  const { svg: edited, ...stop } = edit
  const { png } = await compare(page, input, edited)
  const raster = pngBytes(png)
  const svgPath = join(dir, 'edited-stop.svg')
  const renderPath = join(dir, 'edited-stop.png')
  await writeFile(join(out, svgPath), edited)
  await writeFile(join(out, renderPath), raster)
  return { gradientId, ...stop, svgPath, renderPath, renderChanged: !originalRender.equals(raster) }
}

async function vectorize(browser, input, engine, round) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 }, reducedMotion: 'reduce' })
  // Keep tracing and browser timing independent of the remote UI font stylesheet.
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.addInitScript(() => localStorage.setItem('rastavec.locale', 'en'))
  const page = await context.newPage()
  const browserErrors = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  const dir = join('runs', input.stem, engine, String(round))
  await mkdir(join(out, dir), { recursive: true })
  const result = { fixture: input.id, size: input.maxSide, engine, round, browserErrors }
  try {
    await page.goto(appUrl.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.locator('button.cta').waitFor()
    const gradients = page.locator('#experimental-gradients')
    assert.equal(await gradients.isChecked(), false, 'Experimental gradients are off by default')
    await gradients.setChecked(engine === 'next-gradients')
    assert.equal(await gradients.isChecked(), engine === 'next-gradients')
    const preset = page.locator('.preset').filter({ has: page.getByText(presets[args.preset], { exact: true }) })
    await preset.click()
    const autoTune = page.locator('button.toggle')
    if ((await autoTune.getAttribute('aria-pressed') === 'true') !== (args.preset === 'auto')) await autoTune.click()
    if (args.preset === 'gradient-probe') {
      await page.locator('#ld').fill('12')
      await page.locator('#sp').fill('0')
    }
    await page.locator('input[type=file][multiple]:not([webkitdirectory])').setInputFiles(join(out, input.path))
    if (round === 1 && input.id === selectedCases[0].id && input.maxSide === sizes[0]) {
      await page.screenshot({ path: join(out, dir, 'import.png') })
    }

    const started = performance.now()
    await page.locator('button.cta').click()
    await page.waitForFunction(() => document.querySelector('.exportbar') || document.querySelector('.tile .chip')?.textContent?.trim() === 'Error', null, { timeout: 120000 })
    result.elapsedMs = performance.now() - started
    const tile = page.locator('.tile')
    assert(await tile.isEnabled(), await tile.innerText())
    result.tile = await tile.innerText()
    result.lotHeading = await page.locator('h1').innerText()

    const zipPromise = page.waitForEvent('download')
    await page.locator('.exportbar button').click()
    const zipDownload = await zipPromise
    const zipPath = join(out, dir, 'batch.zip')
    await zipDownload.saveAs(zipPath)
    const zip = await JSZip.loadAsync(await readFile(zipPath))
    const config = JSON.parse(await zip.file('config.json').async('string'))
    assert.equal(config.traceEngine, engine, 'Unexpected engine in batch config')
    result.exportConfig = config
    result.exportMetrics = await zip.file('metrics.csv').async('string')

    await tile.click()
    const svgPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click()
    const svgDownload = await svgPromise
    result.svgPath = join(dir, 'export.svg')
    await svgDownload.saveAs(join(out, result.svgPath))
    const svg = await readFile(join(out, result.svgPath))
    const zippedSvg = await zip.file(`svg/${svgDownload.suggestedFilename()}`).async('nodebuffer')
    assert(svg.equals(zippedSvg), 'Individual and batch exports differ')
    result.bytes = svg.length
    result.sha256 = sha256(svg)
    const { png, ...metrics } = await compare(page, input, svg.toString('utf8'))
    result.metrics = metrics
    result.renderPath = join(dir, 'render.png')
    const render = pngBytes(png)
    await writeFile(join(out, result.renderPath), render)
    assert.equal(metrics.brokenReferences.length, 0, `Broken SVG references: ${metrics.brokenReferences.join(', ')}`)
    assert.equal(browserErrors.length, 0, browserErrors.join('\n'))
    if (round === 1) {
      await page.screenshot({ path: join(out, dir, 'detail.png') })
      if (metrics.gradientIds.length) result.editedStop = await editGradientStop(page, input, svg.toString('utf8'), metrics.gradientIds[0], dir, render)
    }
  } catch (error) {
    result.error = String(error)
    await page.screenshot({ path: join(out, dir, 'failure.png'), timeout: 5000 }).catch(() => {})
  } finally {
    await context.close()
  }
  return result
}

const html = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
const urlPath = (path) => html(path.replaceAll('\\', '/'))
const format = (number) => number == null ? '—' : number.toFixed(2)
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2
}

const profileDescription = {
  auto: 'Auto preset with Auto-Tune enabled',
  shaded: 'Shaded illustration with Auto-Tune off',
  flat: 'Flat logo with Auto-Tune off',
  'gradient-probe': 'Shaded illustration with precision 8, layer difference 12, speckle and soft layers at 0, and Auto-Tune off',
}

function review(report) {
  const sections = report.inputs.map((input) => `<section><h2>${html(input.title)} · ${input.width}×${input.height}</h2>
  <p><a href="${html(input.provenance.source)}">Source artwork</a>${input.provenance.note ? ` · ${html(input.provenance.note)}` : ''}</p>
  <div class="row"><figure><img src="${urlPath(input.path)}" alt="Input raster"><figcaption>Input PNG</figcaption></figure>
  ${selectedEngines.map((engine) => {
    const runs = report.results.filter((result) => result.fixture === input.id && result.size === input.maxSide && result.engine === engine)
    const passed = runs.filter((result) => !result.error)
    const sample = passed[0]
    if (!sample) return `<figure><figcaption>${html(engine)}<br>${html(runs[0]?.error ?? 'Pending')}</figcaption></figure>`
    const m = sample.metrics
    return `<figure><img src="${urlPath(sample.renderPath)}" alt="${html(engine)} render"><figcaption><a href="${urlPath(sample.svgPath)}">${html(engine)} SVG</a>
    <br>${m.paths} paths · ${m.gradientPaints} used gradients · ${sample.bytes} bytes
    <br>White / dark RMSE ${format(m.whiteRmse)} / ${format(m.darkRmse)} · alpha MAE ${format(m.alphaMae)}
    <br>${Math.round(median(passed.map((run) => run.elapsedMs)))} ms median (${passed.length}/${runs.length} successful)
    ${passed.length > 1 ? `<br>${new Set(passed.map((run) => run.sha256)).size} distinct SVG export(s)` : ''}
    ${sample.editedStop ? `<br>Edited stop <a href="${urlPath(sample.editedStop.svgPath)}">SVG</a> · <a href="${urlPath(sample.editedStop.renderPath)}">render</a>` : ''}</figcaption></figure>`
  }).join('')}</div></section>`).join('\n')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RastaVec engine comparison</title>
  <style>body{font:16px system-ui;margin:2rem;color:#24242b}section{border-top:1px solid #ccc;margin-top:2rem}.row{display:flex;gap:1rem;flex-wrap:wrap}figure{margin:0;width:min(100%,300px)}img{box-sizing:border-box;display:block;width:100%;height:260px;object-fit:contain;border:1px solid #aaa;background:var(--bg,#fff)}figcaption{margin:.4rem 0}button{margin-right:.5rem}</style>
  <h1>RastaVec engine comparison</h1><p>${html(profileDescription[report.preset])} · Chromium ${html(report.chromium)} · <a href="report.json">Run data and provenance</a></p>
  <p>Use both backgrounds to inspect shadow coverage, banding, seams, and small logo details. RMSE and alpha MAE use 0–255 values and lower is closer to the input. Timing includes browser processing and app metrics.</p>
  <button type="button" data-bg="#fff">White</button><button type="button" data-bg="#202020">Dark</button>
  <script>for(const button of document.querySelectorAll('[data-bg]'))button.onclick=()=>document.body.style.setProperty('--bg',button.dataset.bg)</script>
  ${sections}`
}

await mkdir(join(out, 'inputs'), { recursive: true })
const report = { startedAt: new Date().toISOString(), app: appUrl.href, dist: args.dist ? resolve(args.dist) : undefined,
  revision: revision(root), workingTree: workingTree(), node: process.version, platform: process.platform,
  engineArtifacts: await engineArtifacts(), buildArtifacts: args.dist ? await buildArtifacts(resolve(args.dist)) : undefined,
  preset: args.preset, sizes, repeats, engines: selectedEngines, inputs: [], results: [] }
const save = async () => {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(out, 'index.html'), review(report))
}
let server, browser
try {
  if ((args.serve || args.dist) && !args['prepare-only']) {
    const { createServer, preview } = await import('vite')
    const listener = { host: appUrl.hostname.replace(/^\[|\]$/g, ''), port: Number(appUrl.port || '80'), strictPort: true }
    if (args.dist) {
      server = await preview({ root, configFile: false, build: { outDir: resolve(args.dist) }, preview: listener })
    } else {
      server = await createServer({ root, server: { ...listener, watch: { ignored: ['**/output/**'] } } })
      await server.listen()
    }
    console.log(`Serving RastaVec at ${appUrl.href}`)
  }
  browser = await chromium.launch(args.executable ? { executablePath: args.executable } : { channel: args.channel })
  report.chromium = browser.version()
  const setup = await browser.newPage()
  for (const fixture of selectedCases) for (const size of sizes) {
    const input = await makeInput(setup, fixture, size)
    report.inputs.push(input)
    console.log(`Input ${input.stem}: ${input.width}×${input.height}`)
  }
  await setup.close()
  await save()
  if (!args['prepare-only']) {
    for (const input of report.inputs) for (let round = 1; round <= repeats; round++) {
      // Rotate order to reduce systematic warmup and background-load effects.
      const offset = (round - 1) % selectedEngines.length
      for (const engine of [...selectedEngines.slice(offset), ...selectedEngines.slice(0, offset)]) {
        const result = await vectorize(browser, input, engine, round)
        report.results.push(result)
        console.log(`${input.stem} ${engine} #${round}: ${result.error ?? `${Math.round(result.elapsedMs)} ms, ${result.metrics.paths} paths, ${result.metrics.gradientPaints} gradients, white RMSE ${format(result.metrics.whiteRmse)}`}`)
        await save()
      }
    }
  }
} finally {
  await browser?.close()
  await server?.close()
}
console.log(`Review: ${join(out, 'index.html')}`)
if (report.results.some((result) => result.error)) process.exitCode = 1
