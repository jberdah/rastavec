import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMeasurementQueue } from '../src/lib/measurement-queue.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
test('coalesces rapid changes and does not run measurements concurrently', async () => {
  const q = createMeasurementQueue(5)
  const seen = []
  let active = 0, max = 0
  const task = (name) => async () => { active++; max = Math.max(max, active); seen.push(name); await sleep(15); active-- }
  q.schedule('a', task('old'))
  q.schedule('a', task('new'))
  q.schedule('b', task('other'))
  await sleep(100)
  assert.deepEqual(seen, ['new', 'other'])
  assert.equal(max, 1)
})
test('cancels queued measurements', async () => {
  const q = createMeasurementQueue(5)
  let called = false
  q.schedule('a', async () => { called = true })
  q.cancel('a')
  await sleep(30)
  assert.equal(called, false)
})
