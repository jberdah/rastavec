// Small, project-local synthetic raster controls for the source-free proposal CLI.
// SVG inputs are generated into a temporary directory; annotations and truth masks
// are intentionally absent from both the fixture and the inference invocation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const cli = resolve('dist/rastavec.cjs')
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">${body}</svg>`
const scenes = {
  venn_alpha: svg('<g opacity="0.75"><circle cx="48" cy="52" r="36" fill="#00f0ff"/><circle cx="80" cy="52" r="36" fill="#ff007f"/><circle cx="64" cy="82" r="36" fill="#ffec00"/></g>'),
  mixed_gradient: svg('<defs><linearGradient id="g"><stop stop-color="#2980b9"/><stop offset="1" stop-color="#8e44ad"/></linearGradient></defs><rect x="10" y="14" width="58" height="58" rx="8" fill="url(#g)" opacity="0.7"/><circle cx="89" cy="48" r="27" fill="#e67e22" opacity="0.65"/><polygon points="30,118 104,118 67,62" fill="#f1c40f" opacity="0.8"/>'),
  multiply_overlap: svg('<rect width="128" height="128" fill="#ffffff"/><g style="mix-blend-mode:multiply"><rect x="20" y="38" width="72" height="38" transform="rotate(-15 56 57)" fill="#00aeef" opacity="0.8"/><circle cx="82" cy="66" r="29" fill="#ec008c" opacity="0.8"/><polygon points="32,112 112,112 72,50" fill="#fff200" opacity="0.9"/></g>'),
}

test('objects emits source-free, review-required visible-mask proposals for generated controls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-object-proposals-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const inputs = []
  for (const [name, source] of Object.entries(scenes)) {
    const path = join(dir, `${name}.png`)
    await sharp(Buffer.from(source)).png().toFile(path)
    inputs.push(path)
  }

  const out = join(dir, 'proposals')
  const result = spawnSync(process.execPath, [cli, 'objects', ...inputs, '--out', out, '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.command, 'objects')
  assert.equal(report.inferenceUsesSourceSvg, false)
  assert.equal(report.mobileSam.enabled, false)
  assert.equal(report.summary.total, inputs.length)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.items.length, inputs.length)
  assert.deepEqual(report.items.map((item) => item.name).sort(), Object.keys(scenes).sort())
  const allRoutes = report.items.flatMap((item) => item.routes)
  assert.equal(report.summary.abstainedProviders, allRoutes.filter((route) => route.status === 'abstained').length)
  assert.equal(report.summary.proposedProviders, allRoutes.filter((route) => route.status === 'proposed').length)

  for (const item of report.items) {
    assert.equal(item.status, 'proposed', item.name)
    assert.equal(item.decision, 'human-review-required', item.name)
    assert.equal(item.routeRecommendation?.humanReviewRequired, true, item.name)
    assert.equal('sourceSvg' in item, false)
    assert.equal('fullGeometryMask' in item, false)
    assert.ok(Array.isArray(item.routes), item.name)
    const connected = item.routes.find((route) => route.provider === 'visible-connected-components')
    assert.equal(connected?.status, 'proposed', item.name)
    assert.ok(connected.hypotheses.length > 0, item.name)
    for (const hypothesis of connected.hypotheses) {
      assert.equal(hypothesis.maskMeaning, 'visible-object')
      const maskPath = join(out, hypothesis.mask.file)
      assert.ok(existsSync(maskPath), maskPath)
      const metadata = await sharp(maskPath).metadata()
      assert.equal(metadata.width, item.width)
      assert.equal(metadata.height, item.height)
      assert.equal(metadata.hasAlpha, true, `${maskPath} must preserve alpha`)
      assert.match(readFileSync(maskPath).subarray(0, 8).toString('hex'), /^89504e470d0a1a0a$/)
      const { data, info } = await sharp(maskPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let nonzeroAlphaPixels = 0
      let transparentPixels = 0
      for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
        if (data[pixel * info.channels + 3] === 0) transparentPixels += 1
        else nonzeroAlphaPixels += 1
      }
      assert.ok(nonzeroAlphaPixels > 0, `${maskPath} must contain visible-mask support`)
      assert.ok(transparentPixels > 0, `${maskPath} must preserve a transparent exterior`)
    }
  }
})

test('objects can associate proposals with paint-aware paths from its own trace', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-object-path-associations-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'venn.png')
  await sharp(Buffer.from(scenes.venn_alpha)).png().toFile(input)

  const out = join(dir, 'associated')
  const result = spawnSync(process.execPath, [cli, 'objects', input, '--associate-paths', '--out', out, '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  const item = report.items[0]

  assert.equal(item.tracePathAssociations.status, 'ready')
  assert.ok(item.tracePathAssociations.paths.length > 0)
  assert.ok(item.tracePathAssociations.diagnostics.rendererCalls > 0)
  assert.ok(existsSync(item.tracePathAssociations.traceSvg))
  for (const route of item.routes.filter(({ status }) => status === 'proposed')) {
    assert.equal(route.pathAssociations.status, 'ready', route.provider)
    assert.ok(Number.isSafeInteger(route.pathAssociations.paintedPaths), route.provider)
    assert.equal(route.hypotheses.every((hypothesis) => Array.isArray(hypothesis.pathAssociations)), true, route.provider)
  }
  assert.equal(item.inferenceUsesSourceSvg, undefined)
  assert.equal(report.inferenceUsesSourceSvg, false)
})

test('requested optional MobileSAM initialization failure abstains without blocking available routes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-object-mobile-sam-fallback-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'venn.png')
  await sharp(Buffer.from(scenes.venn_alpha)).png().toFile(input)

  const out = join(dir, 'proposals')
  const missingEncoder = join(dir, 'missing-encoder.onnx')
  const missingDecoder = join(dir, 'missing-decoder.onnx')
  const result = spawnSync(process.execPath, [cli, 'objects', input,
    '--sam-encoder', missingEncoder, '--sam-decoder', missingDecoder,
    '--out', out, '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual({ enabled: report.mobileSam.enabled, status: report.mobileSam.status, verified: report.mobileSam.modelFilesVerifiedBySha256 },
    { enabled: true, status: 'unavailable', verified: false })
  assert.equal(report.summary.errors, 0)
  const routes = report.items[0].routes
  const mobileSam = routes.find((route) => route.provider === 'mobile-sam')
  assert.equal(mobileSam.status, 'abstained')
  assert.equal(mobileSam.diagnostics.stage, 'initialization')
  assert.equal(routes.find((route) => route.provider === 'visible-connected-components').status, 'proposed')
})

test('missing optional ONNX runtime leaves the CLI object routes usable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-object-onnx-absent-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'venn.png')
  await sharp(Buffer.from(scenes.venn_alpha)).png().toFile(input)

  const out = join(dir, 'proposals')
  const preload = join(dir, 'hide-optional-onnx-runtime.cjs')
  writeFileSync(preload, `
    const Module = require('node:module')
    const load = Module._load
    Module._load = function(request, parent, isMain) {
      if (request === 'onnxruntime-web/wasm') {
        const error = new Error('Optional ONNX runtime is absent')
        error.code = 'MODULE_NOT_FOUND'
        throw error
      }
      return load.call(this, request, parent, isMain)
    }
  `)
  const result = spawnSync(process.execPath, ['--require', preload, cli, 'objects', input,
    '--sam-encoder', join(dir, 'encoder.onnx'), '--sam-decoder', join(dir, 'decoder.onnx'),
    '--out', out, '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.mobileSam.status, 'unavailable')
  assert.equal(report.summary.errors, 0)
  const routes = report.items[0].routes
  assert.equal(routes.find((route) => route.provider === 'mobile-sam').status, 'abstained')
  assert.equal(routes.find((route) => route.provider === 'visible-connected-components').status, 'proposed')
})
