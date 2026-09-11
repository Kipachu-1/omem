/** Shared, deterministic checks. Citation syntax is not source verification. */
export const ACTIVE_NOTE_SQL = "path NOT LIKE 'archive/%' AND json_extract(frontmatter, '$.archived_at') IS NULL"

export function isNavigationOnly(text: string): boolean {
  const body = text.replace(/^#{1,6}\s+.*$/gm, '').trim()
  if (!body) return true
  if (!/\[\[.*?\]\]|\[[^\]]*\]\([^)]*\)/.test(body)) return false
  return !body
    .replace(/\[\[.*?\]\]/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^[\s>*+\-\d.)]+/gm, '')
    .replace(/[\s,;:|—–-]/g, '')
}

export function validCitation(fm: Record<string, unknown>): boolean {
  if (typeof fm.source_url !== 'string' || typeof fm.source_version !== 'string') return false
  const version = fm.source_version.trim()
  if (!version || /[<>]|^(latest|unknown|todo|\.\.\.)$/i.test(version)) return false
  try {
    const url = new URL(fm.source_url)
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname &&
      !url.username && !url.password && !/[<>]|\.\.\./.test(fm.source_url)
  } catch {
    return false
  }
}
