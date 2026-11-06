/**
 * Allocate names without collisions on case-insensitive filesystems.
 * @param {string} stem
 * @param {Set<string>} used Lowercase names already allocated.
 * @returns {string}
 */
export function uniqueImportName(stem, used) {
  const base = stem || 'image'
  let name = base
  for (let suffix = 2; used.has(name.toLocaleLowerCase('en-US')); suffix++) name = `${base}-${suffix}`
  used.add(name.toLocaleLowerCase('en-US'))
  return name
}
