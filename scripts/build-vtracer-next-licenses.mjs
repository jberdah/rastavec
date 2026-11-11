// Writes public/licenses/vtracer-next-third-party.txt: the license notices of the Rust crates
// that the VTracer-Next WebAssembly module is built from.
//
// The module is distributed as a binary, so the notices its dependencies require (MIT,
// Apache-2.0, BSD-2-Clause) have to travel with it. Run this after `npm run build:vtracer-next`,
// whenever the engine or its lockfile changes:
//
//   node scripts/build-vtracer-next-licenses.mjs [staged adapter directory]
//
// It reads the dependency list from the staged build workspace (the newest
// .tmp/vtracer-next-build-*/adapter by default) and the license files from the local Cargo
// registry, which that build has just populated.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = join(root, '.tmp')
const staged = process.argv[2]
  ? resolve(process.argv[2])
  : readdirSync(scratch)
      .filter((name) => name.startsWith('vtracer-next-build-') && existsSync(join(scratch, name, 'adapter', 'Cargo.toml')))
      .map((name) => join(scratch, name, 'adapter'))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
if (!staged || !existsSync(join(staged, 'Cargo.toml'))) throw new Error('No staged VTracer-Next build found. Run `npm run build:vtracer-next` first, or pass the adapter directory.')

const tree = spawnSync('cargo', ['tree', '--locked', '--target', 'wasm32-unknown-unknown', '-e', 'normal', '--prefix', 'none'], { cwd: staged, encoding: 'utf8' })
if (tree.status !== 0) throw new Error(`cargo tree failed:\n${tree.stderr}`)
// Registry crates print as "name vX.Y.Z"; workspace crates carry a path in parentheses.
const crates = [...new Set(tree.stdout.split(/\r?\n/).map((line) => line.replace(/ \(\*\)$/, '').trim()).filter((line) => /^[\w-]+ v[\w.+-]+$/.test(line)))]
  .map((line) => { const [name, version] = line.split(' v'); return { name, version } })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo')
const registries = join(cargoHome, 'registry', 'src')
const sourceOf = ({ name, version }) => readdirSync(registries).map((registry) => join(registries, registry, `${name}-${version}`)).find(existsSync)
const field = (manifest, key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(manifest)?.[1]
const canonical = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()

const sections = []
const apacheOnly = []
let apacheText
for (const crate of crates) {
  const directory = sourceOf(crate)
  if (!directory) throw new Error(`Crate source not found in the Cargo registry: ${crate.name} ${crate.version}`)
  const manifest = readFileSync(join(directory, 'Cargo.toml'), 'utf8')
  const license = (field(manifest, 'license') ?? 'see the crate').replaceAll('/', ' OR ')
  const repository = field(manifest, 'repository') ?? field(manifest, 'homepage') ?? `https://crates.io/crates/${crate.name}`
  const files = readdirSync(directory).filter((name) => /^(licen[cs]e|copying|unlicense)/i.test(name)).sort()
  // Dual-licensed crates are used under MIT; Apache-only ones point at the Apache text below.
  const mit = files.find((name) => /mit/i.test(name))
  const apache = files.find((name) => /apache/i.test(name))
  const single = files.find((name) => !/mit|apache/i.test(name))
  const usesApache = /^Apache-2\.0$/.test(license)
  if (apache || (usesApache && single)) apacheText ??= canonical(readFileSync(join(directory, apache ?? single), 'utf8'))
  let body
  if (usesApache) {
    apacheOnly.push(`${crate.name} ${crate.version}`)
    body = 'Licensed under the Apache License, Version 2.0, reproduced at the end of this file.\nThe crate ships no NOTICE file.'
  } else {
    // "A AND B" needs every text; "A OR B" needs the one chosen.
    const chosen = / AND /.test(license) ? files.filter((name) => !/apache/i.test(name)) : [mit ?? single ?? files[0]].filter(Boolean)
    if (!chosen.length) throw new Error(`No license file in ${crate.name} ${crate.version}`)
    body = chosen.map((name) => canonical(readFileSync(join(directory, name), 'utf8'))).join(`\n\n${'-'.repeat(78)}\n\n`)
  }
  const choice = / AND /.test(license) ? ' (the MIT alternative, together with the other terms listed)' : / OR /.test(license) ? ' (used under MIT)' : ''
  sections.push(`${'='.repeat(78)}\n${crate.name} ${crate.version}\nLicense: ${license}${choice}\nSource: ${repository}\n${'='.repeat(78)}\n\n${body}`)
}
if (apacheOnly.length && !apacheText) throw new Error('An Apache-2.0 crate is present but no Apache license text was found to reproduce.')

const header = `Third-party notices for the VTracer-Next WebAssembly module
============================================================

The module (vtracer_next_bg.wasm and its JavaScript glue) is built from VTracer-Next, whose
own license is in vtracer-next.txt, and from the Rust crates below. Some of them are compiled
into the module; others (procedural macros and their helpers) only run while it is built.
Their notices are reproduced here as their licenses require for binary distribution.

Generated by scripts/build-vtracer-next-licenses.mjs from the locked build of the module.
${crates.length} crates.`
const footer = apacheOnly.length ? `\n\n${'='.repeat(78)}\nApache License, Version 2.0 (applies to: ${apacheOnly.join(', ')})\n${'='.repeat(78)}\n\n${apacheText}` : ''
const output = join(root, 'public', 'licenses', 'vtracer-next-third-party.txt')
writeFileSync(output, `${header}\n\n${sections.join('\n\n')}${footer}\n`)
console.log(`Wrote ${output}: ${crates.length} crates, ${apacheOnly.length} under Apache-2.0 only.`)
