// Deterministic sprite-sheet slicing (pure TS, no DOM).
// 1. Foreground mask: alpha >= 128, or, for an opaque sheet, "differs from the background
//    colour" (the most common colour among the four corners).
// 2. Connected components (8-neighbour) on a 2 px grid.
// 3. Large components become elements; small ones (sparkles, notes, dots) are attached to the
//    nearest element within a merge distance, so decorations stay with their character.
import type { RGBAImage } from './core'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface SliceResult {
  boxes: Box[]
  background: 'transparent' | string
  /** Small components that were too far from any element and dropped. */
  dropped: number
}

const CELL = 2

function backgroundColor(img: RGBAImage): [number, number, number] | null {
  const { data: d, width: w, height: h } = img
  const corners = [0, w - 1, (h - 1) * w, h * w - 1].map((p) => p * 4)
  if (corners.some((i) => d[i + 3] < 128)) return null // transparent sheet
  const keys = corners.map((i) => `${d[i] >> 3},${d[i + 1] >> 3},${d[i + 2] >> 3}`)
  const best = keys.reduce((a, k) => (keys.filter((x) => x === k).length > keys.filter((x) => x === a).length ? k : a), keys[0])
  const i = corners[keys.indexOf(best)]
  return [d[i], d[i + 1], d[i + 2]]
}

export function sliceSheet(img: RGBAImage, opts: { pad?: number } = {}): SliceResult {
  const { data: d, width: W, height: H } = img
  const pad = opts.pad ?? 6
  const bg = backgroundColor(img)
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL)
  const g = new Uint8Array(gw * gh)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      let fg: boolean
      if (bg) fg = Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) > 24
      else fg = d[i + 3] >= 128
      if (fg) g[((y / CELL) | 0) * gw + ((x / CELL) | 0)] = 1
    }
  }

  interface Comp { x0: number; y0: number; x1: number; y1: number; ink: number }
  const comps: Comp[] = []
  const lab = new Uint8Array(gw * gh)
  const stack: number[] = []
  for (let s = 0; s < gw * gh; s++) {
    if (!g[s] || lab[s]) continue
    const c: Comp = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, ink: 0 }
    lab[s] = 1
    stack.push(s)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % gw, y = (p / gw) | 0
      c.ink++
      if (x < c.x0) c.x0 = x
      if (y < c.y0) c.y0 = y
      if (x > c.x1) c.x1 = x
      if (y > c.y1) c.y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy
          if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue
          const q = Y * gw + X
          if (g[q] && !lab[q]) { lab[q] = 1; stack.push(q) }
        }
      }
    }
    comps.push(c)
  }

  // Thresholds scale with the sheet size.
  const bigInk = Math.max(300, Math.round(gw * gh * 0.0035))
  const mergeDist = 0.07 * Math.min(W, H)
  const toPx = (c: Comp) => ({ x0: c.x0 * CELL, y0: c.y0 * CELL, x1: Math.min(W, (c.x1 + 1) * CELL), y1: Math.min(H, (c.y1 + 1) * CELL) })
  const big = comps.filter((c) => c.ink >= bigInk).map(toPx)
  const small = comps.filter((c) => c.ink < bigInk && c.ink >= 15).map(toPx)
  // A sheet with a single subject (or only small parts) is one element.
  if (!big.length && small.length) big.push(small.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })))
  // Group large parts that sit side by side on the same line (letters of a wordmark,
  // a symbol next to its text) or overlap: small horizontal gap, strong vertical overlap.
  const gap = 0.02 * Math.min(W, H)
  for (let changed = true; changed; ) {
    changed = false
    outer: for (let a = 0; a < big.length; a++) {
      for (let b = a + 1; b < big.length; b++) {
        const A = big[a], B = big[b]
        const gx = Math.max(A.x0 - B.x1, B.x0 - A.x1, 0)
        const gy = Math.max(A.y0 - B.y1, B.y0 - A.y1, 0)
        const overlapY = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0)
        const sameLine = overlapY >= 0.5 * Math.min(A.y1 - A.y0, B.y1 - B.y0)
        // Letters are much closer than spaced swatches or icons: the gap must also be small
        // relative to the parts' height.
        const hA = A.y1 - A.y0, hB = B.y1 - B.y0
        const tight = gx <= Math.min(gap, 0.06 * Math.min(hA, hB))
        // A clearly smaller part (initial letter, icon next to text) hanging on the side of a
        // larger block, within its height: attach it. Similar-sized neighbours stay apart.
        const [S, L] = hA < hB ? [A, B] : [B, A]
        const hanging = gx <= gap && S.y1 - S.y0 <= 0.6 * (L.y1 - L.y0) && S.y0 >= L.y0 && S.y1 <= L.y1
        if ((gx === 0 && gy === 0) || (tight && sameLine) || hanging) {
          big[a] = { x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0), x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1) }
          big.splice(b, 1)
          changed = true
          break outer
        }
      }
    }
  }
  let dropped = 0
  for (const s of small) {
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2
    let best = -1, bd = Infinity
    big.forEach((b, k) => {
      const dd = Math.hypot(Math.max(b.x0 - cx, 0, cx - b.x1), Math.max(b.y0 - cy, 0, cy - b.y1))
      if (dd < bd) { bd = dd; best = k }
    })
    if (best >= 0 && bd <= mergeDist) {
      const b = big[best]
      b.x0 = Math.min(b.x0, s.x0); b.y0 = Math.min(b.y0, s.y0); b.x1 = Math.max(b.x1, s.x1); b.y1 = Math.max(b.y1, s.y1)
    } else dropped++
  }
  // Second pass: attaching decorations can make blocks overlap (a tagline under an initial
  // letter). Merge blocks that overlap substantially (> 25 % of the smaller one).
  for (let changed = true; changed; ) {
    changed = false
    outer2: for (let a = 0; a < big.length; a++) {
      for (let b = a + 1; b < big.length; b++) {
        const A = big[a], B = big[b]
        const ix = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0)
        const iy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0)
        if (ix <= 0 || iy <= 0) continue
        const smaller = Math.min((A.x1 - A.x0) * (A.y1 - A.y0), (B.x1 - B.x0) * (B.y1 - B.y0))
        if (ix * iy > 0.25 * smaller) {
          big[a] = { x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0), x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1) }
          big.splice(b, 1)
          changed = true
          break outer2
        }
      }
    }
  }
  // Reading order: rows (by vertical centre, tolerance = median height / 2), then left to right.
  const hs = big.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
  const tol = (hs[Math.floor(hs.length / 2)] ?? 0) / 2 || 1
  big.sort((a, b) => {
    const ra = Math.round((a.y0 + a.y1) / 2 / tol), rb = Math.round((b.y0 + b.y1) / 2 / tol)
    return ra - rb || a.x0 - b.x0
  })
  const boxes = big.map((b) => {
    const x = Math.max(0, b.x0 - pad), y = Math.max(0, b.y0 - pad)
    return { x, y, w: Math.min(W, b.x1 + pad) - x, h: Math.min(H, b.y1 + pad) - y }
  })
  return { boxes, background: bg ? '#' + bg.map((v) => v.toString(16).padStart(2, '0')).join('') : 'transparent', dropped }
}

/** Copy a rectangle out of an image. */
export function crop(img: RGBAImage, b: Box): RGBAImage {
  const out = new Uint8ClampedArray(b.w * b.h * 4)
  for (let y = 0; y < b.h; y++) {
    const s = ((b.y + y) * img.width + b.x) * 4
    out.set(img.data.subarray(s, s + b.w * 4), y * b.w * 4)
  }
  return { data: out, width: b.w, height: b.h }
}

/**
 * Opaque sheets: make the background transparent by flood-filling from the crop borders
 * (colours within 24/255 of the background). Same-coloured areas enclosed by the artwork
 * (eyes, highlights) are kept because they are not connected to the border.
 */
export function keyBackground(img: RGBAImage, hex: string): RGBAImage {
  const bg = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16))
  const { data: d, width: w, height: h } = img
  const out = new Uint8ClampedArray(d)
  const near = (p: number) => Math.max(Math.abs(d[p * 4] - bg[0]), Math.abs(d[p * 4 + 1] - bg[1]), Math.abs(d[p * 4 + 2] - bg[2])) <= 24
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const seed = (p: number) => { if (!seen[p] && near(p)) { seen[p] = 1; stack.push(p) } }
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1) }
  while (stack.length) {
    const p = stack.pop()!
    out[p * 4 + 3] = 0
    const x = p % w, y = (p / w) | 0
    if (x > 0) seed(p - 1)
    if (x < w - 1) seed(p + 1)
    if (y > 0) seed(p - w)
    if (y < h - 1) seed(p + w)
  }
  return { data: out, width: w, height: h }
}
