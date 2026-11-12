import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describeVTracerNext, vtracerNextDirectory, vtracerNextFiles, vtracerNextManifest } from './verify-vtracer-next.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(process.env.VTRACER_NEXT_SOURCE || join(root, '..', 'VTracer-next'))
const scratch = join(root, '.tmp')
const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'build-vtracer-next.sources.json'), 'utf8'))
const canonicalText = content => content.replace(/\r\n?/g, '\n')
const digest = path => createHash('sha256').update(canonicalText(readFileSync(path, 'utf8'))).digest('hex')
for (const [path, expected] of Object.entries(manifest.files)) {
  const absolute = join(source, path)
  if (!existsSync(absolute) || digest(absolute) !== expected) throw new Error(`VTracer-Next source differs from pinned snapshot: ${absolute}. Set VTRACER_NEXT_SOURCE to the matching private source tree.`)
}
const sourceFiles = []
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (entry.isFile()) sourceFiles.push(relative(source, path).replaceAll('\\', '/'))
  }
}
collect(join(source, 'crates', 'vtracer', 'src'))
for (const path of sourceFiles) if (!(path in manifest.files)) throw new Error(`Unpinned source file: ${path}`)
if (process.argv.includes('--verify-sources-only')) {
  console.log(`Verified ${Object.keys(manifest.files).length} pinned VTracer-Next source files.`)
  process.exit(0)
}
mkdirSync(scratch, { recursive: true })
// Use a fresh source and output tree for each explicit rebuild so stale files cannot enter the artifact.
const stage = mkdtempSync(join(scratch, 'vtracer-next-build-'))
const output = join(stage, 'pkg')
mkdirSync(join(stage, 'crates'), { recursive: true })
mkdirSync(join(stage, 'crates', 'vtracer'), { recursive: true })
cpSync(join(source, 'crates', 'vtracer', 'src'), join(stage, 'crates', 'vtracer', 'src'), { recursive: true })
cpSync(join(source, 'crates', 'vtracer', 'Cargo.toml'), join(stage, 'crates', 'vtracer', 'Cargo.toml'))
const crateManifest = join(stage, 'crates', 'vtracer', 'Cargo.toml')
writeFileSync(crateManifest, readFileSync(crateManifest, 'utf8').replace(/\[dev-dependencies\][\s\S]*$/, ''))
cpSync(join(source, 'README.md'), join(stage, 'README.md'))
// The engine's manifests point to its license file (VTracer-Next License 1.0).
cpSync(join(root, 'public', 'licenses', 'vtracer-next.txt'), join(stage, 'LICENSE'))
writeFileSync(join(stage, 'Cargo.toml'), `[workspace]\nmembers = ["crates/vtracer", "adapter"]\nresolver = "2"\n\n[workspace.package]\nversion = "1.0.0-alpha.5"\nauthors = ["VTracer-next contributors"]\nedition = "2024"\nlicense-file = "LICENSE"\nhomepage = "https://github.com/jberdah/vtracer-next#readme"\nrepository = "https://github.com/jberdah/vtracer-next"\n\n[workspace.dependencies]\nvisioncortex = "0.9.3"\nflo_curves = "0.8"\nrayon = "1.10"\n\n[profile.release]\nopt-level = "s"\nlto = true\ncodegen-units = 1\n`)
mkdirSync(join(stage, 'adapter', 'src'), { recursive: true })
let adapter = readFileSync(join(root, 'wasm', 'vtracer', 'src', 'lib.rs'), 'utf8')
if (!adapter.includes('    binary_threshold: Option<u8>,') || !adapter.includes('    Ok(config)')) throw new Error('VTracer adapter changed; update the Next build adapter explicitly')
adapter = adapter.replace('    binary_threshold: Option<u8>,', '    binary_threshold: Option<u8>,\n    experimental_gradients: Option<bool>,')
adapter = adapter.replace('    Ok(config)', '    if let Some(value) = options.experimental_gradients {\n        config.experimental_gradients = value;\n    }\n    Ok(config)')
writeFileSync(join(stage, 'adapter', 'src', 'lib.rs'), adapter)
writeFileSync(join(stage, 'adapter', 'Cargo.toml'), `[package]\nname = "rastavec-vtracer-next-wasm"\nversion = "0.1.0"\nedition = "2024"\npublish = false\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nvtracer = { package = "vtracer-next", path = "../crates/vtracer", features = ["experimental-alpha-gradients"] }\nwasm-bindgen = "0.2"\nserde = { version = "1", features = ["derive"] }\nserde-wasm-bindgen = "0.6"\n\n[package.metadata.wasm-pack.profile.release]\nwasm-opt = false\n`)
copyFileSync(join(root, 'scripts', 'build-vtracer-next.Cargo.lock'), join(stage, 'Cargo.lock'))
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo')
const command = join(cargoHome, 'bin', process.platform === 'win32' ? 'wasm-pack.exe' : 'wasm-pack')
const localBindgen = process.env.VTRACER_NEXT_BINDGEN
if (localBindgen) {
  if (!existsSync(localBindgen)) throw new Error(`Local wasm-bindgen CLI not found: ${localBindgen}`)
  const expected = /\[\[package\]\]\s*name = "wasm-bindgen"\s*version = "([^"]+)"/.exec(readFileSync(join(root, 'scripts', 'build-vtracer-next.Cargo.lock'), 'utf8'))?.[1]
  const version = spawnSync(localBindgen, ['--version'], { encoding: 'utf8' })
  if (!expected || version.status !== 0 || !version.stdout.includes(expected)) throw new Error(`Local wasm-bindgen CLI must match locked version ${expected ?? '(missing)'}.`)
}
const result = spawnSync(existsSync(command) ? command : 'wasm-pack', [
  'build', '--target', 'web', '--out-dir', output, '--out-name', 'vtracer_next', '--release',
  ...(localBindgen ? ['--mode', 'no-install'] : []), '--', '--locked',
], {
  cwd: join(stage, 'adapter'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(scratch, 'vtracer-next-target'),
    PATH: [localBindgen ? dirname(localBindgen) : '', join(cargoHome, 'bin'), process.env.PATH || ''].filter(Boolean).join(delimiter),
  },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const glue = join(output, 'vtracer_next.js')
writeFileSync(glue, `// @ts-nocheck\n${readFileSync(glue, 'utf8')}`)
const generated = pathToFileURL(output + '/')
const artifact = describeVTracerNext(generated)
mkdirSync(vtracerNextDirectory, { recursive: true })
for (const file of vtracerNextFiles) copyFileSync(new URL(file, generated), new URL(file, vtracerNextDirectory))
writeFileSync(vtracerNextManifest, JSON.stringify(artifact, null, 2) + '\n')
