import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uniqueImportName } from '../src/lib/import-names.js'

test('allocates unique names even when an existing stem already has a suffix', () => {
  const used = new Set()
  assert.deepEqual(['logo', 'logo-2', 'logo', 'logo'].map((name) => uniqueImportName(name, used)),
    ['logo', 'logo-2', 'logo-3', 'logo-4'])
})

test('avoids case-insensitive collisions with names already in the batch', () => {
  const used = new Set(['logo', 'logo-2'])
  assert.equal(uniqueImportName('LOGO', used), 'LOGO-3')
  assert.equal(uniqueImportName('Logo-3', used), 'Logo-3-2')
})
