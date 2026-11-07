import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('part animation interpolates rotation and vertical movement with legacy compatibility', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { motionAt } = await server.ssrLoadModule('/src/lib/engine/animation.ts')
    const frames = [
      { timeMs: 0, rotation: 0, translateY: 0 },
      { timeMs: 1000, rotation: 20, translateY: -4 },
    ]
    assert.deepEqual(motionAt(frames, 500, 'linear'), { rotation: 10, translateY: -2 })
    assert.deepEqual(motionAt(frames, 500, 'ease-in-out'), { rotation: 10, translateY: -2 })
    assert.deepEqual(motionAt([{ timeMs: 0, rotation: 6 }, { timeMs: 1000, rotation: 10 }], 500, 'linear'), { rotation: 8, translateY: 0 })
    assert.deepEqual(motionAt([], 500), { rotation: 0, translateY: 0 })
  } finally {
    await server.close()
  }
})

test('walk cycle maps role aliases to coordinated, closed animation tracks', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { buildWalkCycleTracks, canonicalWalkRole, walkAttachmentPivot } = await server.ssrLoadModule('/src/lib/engine/animation.ts')
    assert.equal(canonicalWalkRole('jambe gauche'), undefined, 'unknown localized labels should not silently guess a role')
    assert.equal(canonicalWalkRole('left-leg'), 'leg_left')
    assert.deepEqual(walkAttachmentPivot({ id: 'leg', role: 'leg_left', bounds: [10, 20, 30, 80], pivot: [20, 50] }, '0 0 100 100'), [20, 23])
    assert.deepEqual(walkAttachmentPivot({ id: 'arm', role: 'arm_left', bounds: [10, 20, 30, 40], pivot: [20, 30] }, '0 0 100 100'), [29, 22])
    assert.deepEqual(walkAttachmentPivot({ id: 'manual', role: 'leg_right', bounds: [10, 20, 30, 80], pivot: [15, 24] }, '0 0 100 100'), [15, 24], 'manually edited pivots are preserved')
    assert.deepEqual(walkAttachmentPivot({ id: 'locked', role: 'leg_right', bounds: [10, 20, 30, 80], pivot: [20, 50], locked: true }, '0 0 100 100'), [20, 50], 'locked groups are left unchanged')
    const group = (id, role) => ({ id, role, bounds: [0, 0, 100, 100], pivot: [50, 50] })
    const tracks = buildWalkCycleTracks([
      group('a', 'leg_left'), group('b', 'right_leg'),
      group('c', 'arm left'), group('d', 'torso'),
      group('ignored', 'head'),
    ])
    assert.deepEqual(tracks.map((track) => track.groupId), ['a', 'b', 'c', 'd'])
    assert.deepEqual(tracks[0].keyframes.map((frame) => frame.rotation), [0, 9.9, 14, 9.9, 0, -9.9, -14, -9.9, 0])
    assert.deepEqual(tracks[1].keyframes.map((frame) => frame.rotation), [0, -9.9, -14, -9.9, 0, 9.9, 14, 9.9, 0])
    assert.deepEqual(tracks[2].keyframes.map((frame) => frame.rotation), [0, -5.66, -8, -5.66, 0, 5.66, 8, 5.66, 0])
    assert.deepEqual(tracks[3].keyframes.map((frame) => frame.translateY), [0, -2.5, -5, -2.5, 0, -2.5, -5, -2.5, 0])
    assert.deepEqual(tracks[3].keyframes.map((frame) => frame.timeMs), [0, 125, 250, 375, 500, 625, 750, 875, 1000])
    for (const track of tracks) {
      const { timeMs: _firstTime, ...firstPose } = track.keyframes[0]
      const { timeMs: _lastTime, ...lastPose } = track.keyframes.at(-1)
      assert.deepEqual(firstPose, lastPose, 'the first and last pose should match for a seamless loop')
    }
  } finally {
    await server.close()
  }
})
