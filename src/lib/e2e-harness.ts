// In-app end-to-end harness, compiled in only when VITE_E2E_PORT is set at build time
// (desktop test variant, used on macOS where WKWebView cannot be driven over CDP).
//
// It drives the real UI like a user would (file input, buttons, keyboard on the slider)
// and reports each step to the local test server (e2e/desktop-mac.mjs), which takes a
// screenshot before answering, then sends the collected results.

import { setLocale } from './i18n.svelte'

const BASE = `http://127.0.0.1:${import.meta.env.VITE_E2E_PORT}`
const errors: string[] = []
const origError = console.error.bind(console)
console.error = (...a: unknown[]) => {
  errors.push(a.map(String).join(' '))
  origError(...a)
}
addEventListener('error', (e) => errors.push(String(e.message || e)))
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]

async function until<T>(what: string, fn: () => T | null | undefined | false, timeoutMs = 30000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await sleep(250)
  }
}

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })
  return r.ok ? r.json().catch(() => ({})) : {}
}
const step = (name: string, data: unknown = {}) => post('/step', { name, data })

async function run() {
  const result: Record<string, unknown> = { userAgent: navigator.userAgent, url: location.href }
  try {
    setLocale('en')
    const logo = await until('logo', () => $<HTMLImageElement>('header img.logo'))
    await until('logo loaded', () => logo.complete && logo.naturalWidth > 0)
    result.logo = true
    await step('import')

    // Import through the real file input.
    const { images } = (await (await fetch(BASE + '/images')).json()) as { images: string[] }
    const files = await Promise.all(
      images.map(async (n) => new File([await (await fetch(`${BASE}/images/${encodeURIComponent(n)}`)).blob()], n, { type: 'image/png' })),
    )
    const input = await until('file input', () => $<HTMLInputElement>('input[type=file][multiple]:not([webkitdirectory])'))
    const dt = new DataTransfer()
    files.forEach((f) => dt.items.add(f))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const cta = await until('run button enabled', () => {
      const b = $<HTMLButtonElement>('button.cta')
      return b && !b.disabled ? b : null
    })
    result.imported = cta.textContent?.trim()
    await sleep(1500)
    await step('imported')

    // Vectorise.
    const t0 = performance.now()
    cta.click()
    await until(
      'all tiles done',
      () => {
        const tiles = $$<HTMLButtonElement>('.tile')
        return tiles.length === files.length && tiles.every((t) => !t.disabled) && $('.exportbar')
      },
      // Stay under the test server's 240 s limit so a hang still reports errors and tile state.
      200000,
    )
    result.seconds = Math.round(performance.now() - t0) / 1000
    result.items = $$<HTMLButtonElement>('.tile').map((t) => {
      const vec = t.querySelector<HTMLImageElement>('img.vec')
      const diff = t.querySelector(':scope > .stack .between .mono')?.textContent?.trim() ?? ''
      const foot = [...t.querySelectorAll(':scope > .between.mono span')].map((s) => s.textContent?.trim() ?? '')
      return {
        name: t.querySelector('.nm')?.textContent?.trim(),
        status: t.querySelector('.chip')?.textContent?.trim(),
        done: !t.disabled,
        svgRendered: Boolean(vec && vec.complete && vec.naturalWidth > 0),
        diffText: diff,
        iou: foot[0] ?? '',
        size: foot[1] ?? '',
      }
    })
    await step('batch')

    // Detail view.
    $<HTMLButtonElement>('.tile:not([disabled])')?.click()
    await until('metrics', () => $('dl.metrics'))
    await sleep(800)
    result.detail = Object.fromEntries($$('dl.metrics dt').map((dt) => [dt.textContent?.trim(), dt.nextElementSibling?.textContent?.trim()]))
    await step('detail')

    const knob = $('[role=slider]')
    if (knob) {
      knob.focus()
      for (let i = 0; i < 6; i++) knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      await sleep(300)
      result.slider = knob.getAttribute('aria-valuenow')
      await step('detail-slider')
    }
  } catch (e) {
    result.error = String((e as Error)?.stack ?? e)
    result.tiles = $$<HTMLElement>('.tile').map((t) => t.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200))
    result.progress = $('.progress, [role=progressbar], .status')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 300)
    await step('failure').catch(() => {})
  }
  result.consoleErrors = errors
  await post('/done', result)
}

if (document.readyState === 'complete') run()
else addEventListener('load', () => run())
