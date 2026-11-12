import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const ts = require('typescript')
const pipelineSource = await readFile(join(root, 'src/lib/pipeline.ts'), 'utf8')
const sourceFile = ts.createSourceFile('pipeline.ts', pipelineSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
// Load only the production helper: importing the full Svelte pipeline through Vite SSR hangs here.
const helper = sourceFile.statements.find((statement) =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'recoverWorkerSource')
assert.ok(helper, 'pipeline exports the worker-source recovery helper')
const helperJs = ts.transpileModule(helper.getFullText(sourceFile), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { recoverWorkerSource } = await import(`data:text/javascript;base64,${Buffer.from(helperJs).toString('base64')}`)

class VectorizationCancelled extends Error {}

class FakeWorker {
  workerBuffer = null
  transferredPixels = null
  cancelled = false
  error = null

  postMessage(message, transfer = []) {
    if (message.type === 'cancel') { this.cancelled = true; return }
    assert.equal(message.type, 'vectorize')
    this.transferredPixels = Array.from(new Uint8Array(message.buffer))
    this.workerBuffer = structuredClone(message.buffer, { transfer })
  }

  crash() { this.error = new Error('simulated worker crash') }

  returnSource(source) { source.data = new Uint8ClampedArray(this.workerBuffer) }
}

test('worker transfer, cancellation, crash and retry restore or invalidate cached pixels', async () => {
  const itemId = 'worker-cancel-race'
  const original = { data: new Uint8ClampedArray([1, 2, 3, 255]), width: 1, height: 1 }
  const cache = new Map([[itemId, original]])
  const worker = new FakeWorker()

  worker.postMessage({ type: 'vectorize', buffer: original.data.buffer }, [original.data.buffer])
  assert.equal(original.data.byteLength, 0, 'transfer detaches the UI-thread pixel buffer')
  worker.postMessage({ type: 'cancel' })
  worker.crash()
  const decoded = { data: new Uint8ClampedArray([9, 8, 7, 255]), width: 1, height: 1 }

  await assert.rejects(recoverWorkerSource(
    original, itemId, cache, async () => decoded, () => worker.cancelled, worker.error,
    () => new VectorizationCancelled(),
  ), VectorizationCancelled)
  assert.strictEqual(cache.get(itemId), decoded, 'pixels are restored before cancellation escapes')

  const retryWorker = new FakeWorker()
  retryWorker.postMessage({ type: 'vectorize', buffer: decoded.data.buffer }, [decoded.data.buffer])
  assert.deepEqual(retryWorker.transferredPixels, [9, 8, 7, 255], 'retry transfers valid pixels')
  assert.equal(decoded.data.byteLength, 0, 'the retry transfer is also detached')
  retryWorker.returnSource(decoded)
  assert.deepEqual(Array.from(cache.get(itemId).data), [9, 8, 7, 255], 'a successful worker response restores its source buffer')

  const unrecoverable = { data: new Uint8ClampedArray([4, 5, 6, 255]), width: 1, height: 1 }
  const failedCache = new Map([[itemId, unrecoverable]])
  const failedWorker = new FakeWorker()
  failedWorker.postMessage({ type: 'vectorize', buffer: unrecoverable.data.buffer }, [unrecoverable.data.buffer])
  failedWorker.postMessage({ type: 'cancel' })
  failedWorker.crash()
  await assert.rejects(recoverWorkerSource(
    unrecoverable, itemId, failedCache, async () => { throw new Error('decode failed') },
    () => failedWorker.cancelled, failedWorker.error, () => new VectorizationCancelled(),
  ), VectorizationCancelled)
  assert.equal(failedCache.has(itemId), false, 'failed recovery invalidates the detached cache entry')
})
