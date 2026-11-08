/**
 * Merge consecutive paths in the painted artwork when their paint attributes match.
 * This is deliberately conservative: it never changes paint order and leaves clip
 * geometry in <defs> untouched. The caller must rasterize and validate the result.
 */
export interface PathMergeResult {
  svg: string
  merged: number
}

interface ParsedPath {
  d: string
  fill: string
  transform: string | null
  dValueStart: number
  dValueEnd: number
  quote: string
}

function parsePath(tag: string): ParsedPath | null {
  const opening = tag.match(/^<path\b([\s\S]*?)\s*\/\s*>$/i)
  if (!opening) return null
  const attrsText = opening[1]
  const attrsOffset = tag.indexOf(attrsText)
  const attrs = new Map<string, { value: string; start: number; end: number; quote: string }>()
  const attr = /\s+([\w:-]+)\s*=\s*(["'])(.*?)\2/g
  let cursor = 0
  for (const match of attrsText.matchAll(attr)) {
    const index = match.index ?? 0
    if (attrsText.slice(cursor, index).trim()) return null
    const name = match[1].toLowerCase()
    if (attrs.has(name)) return null
    const valueStart = attrsOffset + index + match[0].indexOf(match[3])
    attrs.set(name, { value: match[3], start: valueStart, end: valueStart + match[3].length, quote: match[2] })
    cursor = index + match[0].length
  }
  if (attrsText.slice(cursor).trim()) return null
  if ([...attrs.keys()].some((name) => !['d', 'fill', 'transform'].includes(name))) return null
  const d = attrs.get('d'), fill = attrs.get('fill'), transform = attrs.get('transform')
  if (!d?.value.trim() || !/^m/i.test(d.value.trim()) || !fill?.value.trim()) return null
  return {
    d: d.value,
    fill: fill.value,
    transform: transform?.value ?? null,
    dValueStart: d.start,
    dValueEnd: d.end,
    quote: d.quote,
  }
}

function samePaint(a: ParsedPath, b: ParsedPath): boolean {
  return a.fill === b.fill && a.transform === b.transform
}

function mergeRange(svg: string, start: number, end: number): PathMergeResult {
  const content = svg.slice(start, end)
  const tags = [...content.matchAll(/<path\b[^>]*?\/\s*>/gi)]
  if (tags.length < 2) return { svg, merged: 0 }

  let output = ''
  let cursor = 0
  let merged = 0
  for (let i = 0; i < tags.length;) {
    const first = tags[i]
    const firstIndex = first.index ?? 0
    const firstTag = first[0]
    const firstPath = parsePath(firstTag)
    if (!firstPath) {
      const nextCursor = firstIndex + firstTag.length
      output += content.slice(cursor, nextCursor)
      cursor = nextCursor
      i++
      continue
    }

    let last = i
    let joinedD = firstPath.d
    for (let j = i + 1; j < tags.length; j++) {
      const previous = tags[j - 1]
      const next = tags[j]
      const previousEnd = (previous.index ?? 0) + previous[0].length
      const nextIndex = next.index ?? 0
      if (content.slice(previousEnd, nextIndex).trim()) break
      const nextPath = parsePath(next[0])
      if (!nextPath || !samePaint(firstPath, nextPath)) break
      joinedD += ` ${nextPath.d}`
      last = j
    }

    const lastTag = tags[last]
    const lastEnd = (lastTag.index ?? 0) + lastTag[0].length
    if (last > i) {
      output += content.slice(cursor, firstIndex)
      const mergedTag = `${firstTag.slice(0, firstPath.dValueStart)}${joinedD}${firstPath.quote}${firstTag.slice(firstPath.dValueEnd + 1)}`
      output += mergedTag
      cursor = lastEnd
      merged += last - i
      i = last + 1
    } else {
      output += content.slice(cursor, firstIndex + firstTag.length)
      cursor = firstIndex + firstTag.length
      i++
    }
  }
  output += content.slice(cursor)
  return merged ? { svg: `${svg.slice(0, start)}${output}${svg.slice(end)}`, merged } : { svg, merged: 0 }
}

export function mergeAdjacentSameFillPaths(svg: string): PathMergeResult {
  const clipGroup = /<g\b(?=[^>]*\bclip-path\s*=\s*(["'])url\(#silhouette\)\1)[^>]*>/i.exec(svg)
  if (clipGroup) {
    const start = (clipGroup.index ?? 0) + clipGroup[0].length
    const close = svg.indexOf('</g>', start)
    if (close < 0) return { svg, merged: 0 }
    return mergeRange(svg, start, close)
  }

  // Color output without a silhouette clip contains only artwork paths at the SVG root.
  // Binary output uses an inherited group fill and is not eligible for this pass.
  const root = /<svg\b[^>]*>/i.exec(svg)
  const end = svg.lastIndexOf('</svg>')
  if (!root || end < 0) return { svg, merged: 0 }
  const start = (root.index ?? 0) + root[0].length
  const defsEnd = svg.indexOf('</defs>', start)
  return mergeRange(svg, defsEnd >= 0 && defsEnd < end ? defsEnd + '</defs>'.length : start, end)
}
