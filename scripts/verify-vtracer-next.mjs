import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
export const vtracerNextDirectory = new URL('src/lib/engine/vtracer-next-wasm/', root)
export const vtracerNextManifest = new URL('scripts/vtracer-next.artifacts.json', root)

const buildInputs = [
  'scripts/build-vtracer-next.mjs',
  'scripts/build-vtracer-next.sources.json',
  'scripts/build-vtracer-next.Cargo.lock',
  'scripts/verify-vtracer-next.mjs',
  'wasm/vtracer/src/lib.rs',
  'public/licenses/vtracer-next.txt',
]

export const vtracerNextFiles = [
  'package.json',
  'vtracer_next.js',
  'vtracer_next.d.ts',
  'vtracer_next_bg.wasm',
  'vtracer_next_bg.wasm.d.ts',
]

function readFile(url) {
  try {
    return readFileSync(url)
  } catch (error) {
    throw new Error(`Cannot read VTracer-Next file ${fileURLToPath(url)}. Restore the checked-in module and build inputs.`, { cause: error })
  }
}

function digest(url) {
  const bytes = readFile(url)
  // Git may check out generated source files with CRLF on Windows.
  const content = url.pathname.endsWith('.wasm') ? bytes : bytes.toString('utf8').replace(/\r\n?/g, '\n')
  return createHash('sha256').update(content).digest('hex')
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid VTracer-Next manifest: ${label} must be an object.`)
  }
  const expected = [...expectedKeys].sort()
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((key) => !actual.includes(key))
    const extra = actual.filter((key) => !expected.includes(key))
    throw new Error(`VTracer-Next ${label} keys mismatch. Missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}.`)
  }
}

function assertExactWasmFiles(directory) {
  const expected = vtracerNextFiles.filter((name) => name.endsWith('.wasm')).sort()
  const actual = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.wasm'))
    .map((entry) => entry.name)
    .sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !actual.includes(name))
    const extra = actual.filter((name) => !expected.includes(name))
    throw new Error(`VTracer-Next WASM artifact set mismatch in ${fileURLToPath(directory)}. Missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}.`)
  }
}

export function describeVTracerNext(directory = vtracerNextDirectory) {
  assertExactWasmFiles(directory)
  if (!WebAssembly.validate(readFile(new URL('vtracer_next_bg.wasm', directory)))) {
    throw new Error('Invalid VTracer-Next WASM. Restore the checked-in module or rebuild it from pinned sources.')
  }
  return {
    inputs: Object.fromEntries(buildInputs.map((name) => [name, digest(new URL(name, root))])),
    files: Object.fromEntries(vtracerNextFiles.map((name) => [name, digest(new URL(name, directory))])),
  }
}

export function verifyVTracerNext() {
  const expected = JSON.parse(readFile(vtracerNextManifest).toString('utf8'))
  assertExactKeys(expected, ['inputs', 'files'], 'manifest sections')
  const actual = describeVTracerNext()
  for (const group of ['inputs', 'files']) {
    assertExactKeys(expected[group], Object.keys(actual[group]), group)
    for (const [name, hash] of Object.entries(actual[group])) {
      if (expected[group]?.[name] !== hash) {
        throw new Error(`VTracer-Next checksum mismatch for ${name}. Restore the matching artifact and build inputs or run npm run build:vtracer-next from pinned sources.`)
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyVTracerNext()
