// Lossless-at-precision path compaction (pure TS, deterministic):
// - bakes a `translate(x,y)` into the coordinates (no transform attribute),
// - writes segments relative to the previous point, computed from already-rounded
//   absolute points so rounding never drifts,
// - shortest number formatting (".5", "-.5", no trailing zeros) and separators,
// - omits repeated command letters.
// Supports the commands VTracer emits (M, L, C, Z, absolute). Anything else is returned untouched.

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

function fmt(v: number, precision: number): string {
  const f = Math.pow(10, precision)
  let r = Math.round(v * f) / f
  if (Object.is(r, -0)) r = 0
  let s = r.toFixed(precision)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s.startsWith('0.')) s = s.slice(1)
  else if (s.startsWith('-0.')) s = '-' + s.slice(2)
  return s === '-0' ? '0' : s
}

/** Append numbers with the shortest valid separators. */
function pushNums(out: string[], nums: string[]) {
  for (const n of nums) {
    const prev = out.length ? out[out.length - 1] : ''
    const prevNum = prev.match(/-?[\d.]+$/)?.[0] ?? ''
    if (!prevNum || n.startsWith('-')) out.push(n) // after a command letter, or a sign starts a new number
    else if (n.startsWith('.') && prevNum.includes('.')) out.push(n) // "1.5" then ".5" -> "1.5.5"
    else out.push(' ' + n)
  }
}

export function parseTranslate(t: string | null): [number, number] | null {
  if (!t) return [0, 0]
  const m = t.trim().match(/^translate\(\s*(-?[\d.e+-]+)(?:[\s,]+(-?[\d.e+-]+))?\s*\)$/i)
  if (!m) return null
  return [parseFloat(m[1]), m[2] ? parseFloat(m[2]) : 0]
}

/**
 * Compact one path. Returns the new `d` with the translation baked in, or null when the path
 * uses something we do not handle (caller keeps the original d and transform).
 */
export function compactPath(d: string, transform: string | null, precision = 2): string | null {
  const tr = parseTranslate(transform)
  if (!tr) return null
  const [tx, ty] = tr
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)
  if (!tokens) return null
  const f = Math.pow(10, precision)
  const q = (v: number) => Math.round(v * f) / f
  const out: string[] = []
  let cx = 0, cy = 0, sx = 0, sy = 0
  let lastCmd = ''
  let i = 0
  const take = (n: number): number[] | null => {
    const vals: number[] = []
    for (let k = 0; k < n; k++) {
      const t = tokens[i + k]
      if (t === undefined || /^[A-Za-z]$/.test(t)) return null
      vals.push(parseFloat(t))
    }
    i += n
    return vals
  }
  let cmd = ''
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++]
    else if (!cmd) return null
    switch (cmd) {
      case 'M': {
        const v = take(2)
        if (!v) return null
        const x = q(v[0] + tx), y = q(v[1] + ty)
        out.push('M')
        pushNums(out, [fmt(x, precision), fmt(y, precision)])
        cx = sx = x; cy = sy = y
        lastCmd = 'M'
        cmd = 'L' // implicit lineto after moveto
        break
      }
      case 'L': {
        const v = take(2)
        if (!v) return null
        const x = q(v[0] + tx), y = q(v[1] + ty)
        if (lastCmd !== 'l') out.push('l')
        pushNums(out, [fmt(x - cx, precision), fmt(y - cy, precision)])
        cx = x; cy = y
        lastCmd = 'l'
        break
      }
      case 'C': {
        const v = take(6)
        if (!v) return null
        const p = v.map((n, k) => q(n + (k % 2 ? ty : tx)))
        if (lastCmd !== 'c') out.push('c')
        pushNums(out, [p[0] - cx, p[1] - cy, p[2] - cx, p[3] - cy, p[4] - cx, p[5] - cy].map((n) => fmt(n, precision)))
        cx = p[4]; cy = p[5]
        lastCmd = 'c'
        break
      }
      case 'Z':
      case 'z':
        out.push('z')
        cx = sx; cy = sy
        lastCmd = 'z'
        cmd = ''
        break
      default:
        return null
    }
  }
  return out.join('')
}

/** Count of numbers in a path, used in tests/diagnostics. */
export const countNumbers = (d: string) => (d.match(NUM) || []).length
