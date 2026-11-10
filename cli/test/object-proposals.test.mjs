// Small, project-local synthetic raster controls for the source-free proposal CLI.
// SVG inputs are generated into a temporary directory; annotations and truth masks
// are intentionally absent from both the fixture and the inference invocation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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


test('MobileSAM runtime can be absent when the provider is not requested', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-cli-without-onnx-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'single-object.png')
  await sharp(Buffer.from(svg('<rect x="20" y="20" width="80" height="80" fill="#222222"/>'))).png().toFile(input)
  const requireHook = join(dir, 'block-onnx.cjs')
  const loader = join(dir, 'block-onnx-loader.mjs')
  writeFileSync(requireHook, `
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (request.startsWith('onnxruntime-web/')) {
    const error = new Error('Simulated missing optional ONNX Runtime')
    error.code = 'MODULE_NOT_FOUND'
    throw error
  }
  return originalLoad.call(this, request, parent, isMain)
}
`)
  writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('onnxruntime-web/')) {
    const error = new Error('Simulated missing optional ONNX Runtime')
    error.code = 'ERR_MODULE_NOT_FOUND'
    throw error
  }
  return nextResolve(specifier, context)
}
`)
  const run = (args) => spawnSync(process.execPath, ['--require', requireHook, '--experimental-loader', pathToFileURL(loader).href, cli, ...args], { encoding: 'utf8' })

  const analyzed = run(['analyze', input, '--json'])
  assert.equal(analyzed.status, 0, analyzed.stderr)
  assert.doesNotThrow(() => JSON.parse(analyzed.stdout))

  const out = join(dir, 'objects-without-onnx')
  const objects = run(['objects', input, '--out', out, '--json'])
  assert.equal(objects.status, 1, objects.stderr)
  const report = JSON.parse(objects.stdout)
  assert.equal(report.summary.errors, 0)
  assert.deepEqual(report.mobileSam, { requested: false, enabled: false })
  assert.equal(report.items[0].routes.some((route) => route.provider === 'mobile-sam'), false)
})

test('requested MobileSAM reports a raster-route fallback when ONNX Runtime is unavailable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-cli-onnx-fallback-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'single-object.png')
  const encoder = join(dir, 'encoder.onnx')
  const decoder = join(dir, 'decoder.onnx')
  await sharp(Buffer.from(svg('<rect x="20" y="20" width="80" height="80" fill="#222222"/>'))).png().toFile(input)
  writeFileSync(encoder, 'encoder placeholder')
  writeFileSync(decoder, 'decoder placeholder')
  const requireHook = join(dir, 'block-onnx.cjs')
  const loader = join(dir, 'block-onnx-loader.mjs')
  writeFileSync(requireHook, `
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (request.startsWith('onnxruntime-web/')) {
    const error = new Error('Simulated missing optional ONNX Runtime')
    error.code = 'MODULE_NOT_FOUND'
    throw error
  }
  return originalLoad.call(this, request, parent, isMain)
}
`)
  writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('onnxruntime-web/')) {
    const error = new Error('Simulated missing optional ONNX Runtime')
    error.code = 'ERR_MODULE_NOT_FOUND'
    throw error
  }
  return nextResolve(specifier, context)
}
`)
  const out = join(dir, 'objects-without-onnx')
  const result = spawnSync(process.execPath, [
    '--require', requireHook, '--experimental-loader', pathToFileURL(loader).href, cli, 'objects', input,
    '--sam-encoder', encoder, '--sam-decoder', decoder, '--out', out, '--json',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.mobileSam.requested, true)
  assert.equal(report.mobileSam.enabled, false)
  assert.equal(report.mobileSam.fallbackProvider, 'visible-connected-components')
  assert.match(report.mobileSam.unavailableReason, /MobileSAM ONNX runtime is unavailable.*onnxruntime-web/)
  const routes = report.items[0].routes
  assert.equal(routes.find((route) => route.provider === 'mobile-sam')?.status, 'abstained')
  assert.match(routes.find((route) => route.provider === 'mobile-sam')?.reason ?? '', /MobileSAM ONNX runtime is unavailable/)
  assert.equal(report.items[0].routeRecommendation.selectedProvider, 'visible-connected-components')

  const textOut = join(dir, 'objects-with-runtime-warning')
  const textResult = spawnSync(process.execPath, [
    '--require', requireHook, '--experimental-loader', pathToFileURL(loader).href, cli, 'objects', input,
    '--sam-encoder', encoder, '--sam-decoder', decoder, '--out', textOut,
  ], { encoding: 'utf8' })
  assert.equal(textResult.status, 1, textResult.stderr)
  assert.match(textResult.stderr, /MobileSAM unavailable: MobileSAM ONNX runtime is unavailable/)
  assert.match(textResult.stderr, /Continuing with raster-only routes/)
})

test('missing requested MobileSAM model files produce a clear fallback diagnostic', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-cli-missing-model-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'single-object.png')
  await sharp(Buffer.from(svg('<rect x="20" y="20" width="80" height="80" fill="#222222"/>'))).png().toFile(input)
  const out = join(dir, 'objects-missing-model')
  const missingEncoder = join(dir, 'missing-encoder.onnx')
  const decoder = join(dir, 'decoder.onnx')
  writeFileSync(decoder, 'decoder placeholder')
  const result = spawnSync(process.execPath, [
    cli, 'objects', input, '--sam-encoder', missingEncoder, '--sam-decoder', decoder, '--out', out, '--json',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.mobileSam.enabled, false)
  assert.equal(report.mobileSam.fallbackProvider, 'visible-connected-components')
  assert.match(report.mobileSam.unavailableReason, /MobileSAM encoder model not found/)
  assert.equal(report.items[0].routes.find((route) => route.provider === 'mobile-sam')?.status, 'abstained')
  assert.equal(report.items[0].routeRecommendation.selectedProvider, 'visible-connected-components')
})
