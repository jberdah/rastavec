import { test } from 'node:test'
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { createServer } from 'vite'

// Minimal transactional IndexedDB double: commits only when a readwrite transaction succeeds.
function storage() {
  let value
  let fail = false
  return {
    failNext() { fail = true },
    open() {
      const request = {}
      const db = {
        createObjectStore() {}, close() {},
        transaction(_name, mode) {
          const tx = { error: null }
          tx.objectStore = () => ({
            get() { return execute('get') },
            put(v) { return execute('put', v) },
            delete() { return execute('delete') },
          })
          function execute(kind, next) {
            const req = { result: undefined, error: null }
            queueMicrotask(() => {
              if (fail && mode === 'readwrite') {
                fail = false; tx.error = new Error('QuotaExceededError'); tx.onabort?.(); return
              }
              if (kind === 'put') value = next
              if (kind === 'delete') value = undefined
              if (kind === 'get') req.result = value
              req.onsuccess?.(); tx.oncomplete?.()
            })
            return req
          }
          return tx
        },
      }
      queueMicrotask(() => { request.result = db; request.onupgradeneeded?.(); request.onsuccess?.() })
      return request
    },
  }
}

test('session saves atomically, preserves settings and refuses to replace an open lot', async () => {
  const previous = { indexedDB: globalThis.indexedDB, File: globalThis.File, Image: globalThis.Image, createImageBitmap: globalThis.createImageBitmap, document: globalThis.document }
  const idb = storage(); globalThis.indexedDB = idb; globalThis.File = File
  globalThis.Image = class { naturalWidth = 1; naturalHeight = 1; set src(_url) { queueMicrotask(() => this.onload()) } }
  globalThis.createImageBitmap = async (file) => { if (file.name === 'bad.png') throw new Error('unreadable image'); return { width: 1, height: 1, close() {} } }
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) }) }) }
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { app } = await server.ssrLoadModule('/src/lib/store.svelte.ts')
    const { captureSession, loadSession, saveSession, restoreSession, deleteSession } = await server.ssrLoadModule('/src/lib/session.ts')
    const file = new File(['image'], 'test.png', { type: 'image/png' })
    app.items = [{ id: 'one', name: 'test', file, srcUrl: 'blob:temporary', srcBytes: file.size, width: 0, height: 0,
      semiPct: 0, status: 'queued', progress: '', trials: [], chosen: 0, autoTuned: false }]
    const badFile = new File(['bad'], 'bad.png', { type: 'image/png' })
    app.items.push({ id: 'two', name: 'bad', file: badFile, srcUrl: 'blob:bad', srcBytes: badFile.size, width: 0, height: 0,
      semiPct: 0, status: 'queued', progress: '', trials: [], chosen: 0, autoTuned: false })
    app.presetId = 'flat'
    app.batchSettings = { presetId: 'flat', params: app.params, auto: app.auto, traceEngine: 'official' }
    const snapshot = captureSession()
    assert.equal(snapshot.traceEngine, 'next')
    assert.equal(snapshot.items[0].file.name, 'test.png')
    assert.equal('srcUrl' in snapshot.items[0], false)
    await saveSession(snapshot)
    assert.equal((await loadSession()).presetId, 'flat')
    idb.failNext()
    await assert.rejects(saveSession({ ...snapshot, presetId: 'pixel' }), /QuotaExceeded/)
    assert.equal((await loadSession()).presetId, 'flat', 'a failed save keeps the previous session')
    await assert.rejects(restoreSession(snapshot), /not empty/)
    app.items = []
    const { traceEngine: _traceEngine, batchSettings, ...legacySnapshot } = snapshot
    const { traceEngine: _batchEngine, ...legacyBatchSettings } = batchSettings
    await restoreSession({ ...legacySnapshot, batchSettings: legacyBatchSettings })
    assert.equal(app.items[0].file.name, 'test.png')
    assert.match(app.items[0].srcUrl, /^blob:/)
    assert.ok(app.items[0].analysis, 'an image saved while queued is analysed when restored')
    assert.equal(app.items[1].status, 'error', 'one unreadable queued image does not block recovery')
    assert.match(app.items[1].error, /unreadable image/)
    assert.equal(app.presetId, 'flat')
    assert.equal(app.traceEngine, 'next', 'a legacy saved session defaults to VTracer-Next')
    assert.equal(app.batchSettings.traceEngine, 'official', 'a historical batch keeps its original engine provenance')
    URL.revokeObjectURL(app.items[0].srcUrl)
    URL.revokeObjectURL(app.items[1].srcUrl)
    app.items = []
    await deleteSession()
    assert.equal(await loadSession(), undefined)
  } finally {
    await server.close()
    Object.assign(globalThis, previous)
  }
})
