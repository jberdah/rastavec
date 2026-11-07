import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const crateDir = join(root, 'wasm', 'vtracer')
const relativeOutDir = '../../src/lib/engine/vtracer1-wasm'
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo')
const localWasmPack = join(cargoHome, 'bin', process.platform === 'win32' ? 'wasm-pack.exe' : 'wasm-pack')
const command = existsSync(localWasmPack) ? localWasmPack : 'wasm-pack'
const result = spawnSync(command, ['build', '--target', 'web', '--out-dir', relativeOutDir, '--out-name', 'vtracer1', '--release'], {
  cwd: crateDir,
  stdio: 'inherit',
  env: { ...process.env, PATH: [join(cargoHome, 'bin'), process.env.PATH || ''].join(delimiter) },
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const generatedGlue = join(root, 'src', 'lib', 'engine', 'vtracer1-wasm', 'vtracer1.js')
const glueSource = readFileSync(generatedGlue, 'utf8')
if (!glueSource.startsWith('// @ts-nocheck')) writeFileSync(generatedGlue, `// @ts-nocheck\n${glueSource}`)
