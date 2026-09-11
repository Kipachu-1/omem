import { createHash } from 'node:crypto'
import type { DB } from './db.ts'
import { validCitation } from './quality.ts'

interface Finding { path: string; detail: string }
interface Findings { count: number; items: Finding[] }
export interface MemoryHealth {
  basis: 'indexed notes; source contents are not verified'
  notes: number
  stale: Findings
  unverified: Findings
  missingCitations: Findings
  brokenLinks: Findings
  possibleDuplicates: Findings
  archivedWithoutReplacement: Findings
}

/** Read-only knowledge audit, with complete counts and at most 20 examples per category.
 * Duplicates use matching titles or normalized bodies, not a semantic duplication claim.
 */
export function memoryHealth(db: DB, now = Date.now(), staleDays = 90): MemoryHealth {
  const empty = (): Findings => ({ count: 0, items: [] })
  const report: MemoryHealth = {
    basis: 'indexed notes; source contents are not verified', notes: 0,
    stale: empty(), unverified: empty(), missingCitations: empty(), brokenLinks: empty(),
    possibleDuplicates: empty(), archivedWithoutReplacement: empty(),
  }
  const add = (bucket: Findings, path: string, detail: string) => {
    bucket.count++
    if (bucket.items.length < 20) bucket.items.push({ path, detail })
  }
  const rows = db.prepare('SELECT path, title, frontmatter, kind FROM notes ORDER BY path')
    .all() as { path: string; title: string; frontmatter: string; kind: string | null }[]
  report.notes = rows.length
  const allPaths = new Set(rows.map(r => r.path))
  const active = new Set<string>()
  const titleGroups = new Map<string, string>()
  const duplicatePaths = new Set<string>()
  const date = (value: unknown) => {
    const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(ms) ? ms : null
  }
  for (const row of rows) {
    const fm = JSON.parse(row.frontmatter || '{}') as Record<string, unknown>
    if (row.path.startsWith('archive/') || fm.archived_at != null) {
      if (row.kind === 'decision' && (typeof fm.superseded_by !== 'string' || !allPaths.has(fm.superseded_by)))
        add(report.archivedWithoutReplacement, row.path, 'Archived decision has no existing superseded_by target.')
      continue
    }
    active.add(row.path)
    if (/\/README\.md$/i.test(row.path)) continue
    const verified = date(fm.verified_at)
    const due = date(fm.review_after)
    if (due != null ? due <= now : verified != null && now - verified > staleDays * 86_400_000)
      add(report.stale, row.path, due != null ? 'review_after is due.' : `Last verified more than ${staleDays} days ago.`)
    if (verified == null) add(report.unverified, row.path, 'No valid verified_at date; file modification time is not verification.')
    if (/^islands\/docs-[^/]+\//.test(row.path) && !validCitation(fm))
      add(report.missingCitations, row.path, 'Needs a valid HTTP(S) source_url and a specific source_version.')
    const title = row.title.trim().toLowerCase().replace(/\s+/g, ' ')
    const previous = titleGroups.get(title)
    if (title && previous) {
      add(report.possibleDuplicates, row.path, `Same title as ${previous}; compare the facts before merging.`)
      duplicatePaths.add(row.path)
    } else if (title) titleGroups.set(title, row.path)
  }
  for (const row of db.prepare("SELECT src_path, raw FROM edges WHERE type = 'wikilink' AND resolved = 0 ORDER BY src_path, raw")
    .all() as { src_path: string; raw: string }[]) {
    if (active.has(row.src_path)) add(report.brokenLinks, row.src_path, `Unresolved wikilink: ${row.raw}`)
  }
  const bodies = new Map<string, string[]>()
  for (const row of db.prepare('SELECT note_path, text FROM chunks ORDER BY note_path, position')
    .all() as { note_path: string; text: string }[]) {
    if (!active.has(row.note_path) || /\/README\.md$/i.test(row.note_path)) continue
    const body = bodies.get(row.note_path) ?? []
    body.push(row.text)
    bodies.set(row.note_path, body)
  }
  const hashes = new Map<string, string>()
  for (const [path, parts] of bodies) {
    const body = parts.join('\n').replace(/^#{1,6}\s+.*$/gm, '').replace(/\s+/g, ' ').trim().toLowerCase()
    if (body.length < 80) continue
    const hash = createHash('sha256').update(body).digest('hex')
    const previous = hashes.get(hash)
    if (previous && !duplicatePaths.has(path)) add(report.possibleDuplicates, path, `Same normalized indexed body as ${previous}; review before merging.`)
    else if (!previous) hashes.set(hash, path)
  }
  return report
}
