import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DB } from './db.ts'
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.ts'
import { indexFile, deleteNote } from './indexer.ts'

export const noteHash = (raw: string): string => createHash('sha256').update(raw).digest('hex')

export interface NoteChange { rel: string; abs: string; raw: string | null }

/** Publish complete files. The shared index transaction serializes cooperating omem writers.
 * External editors do not participate in this lock; this is not a filesystem CAS primitive.
 */
export function commitNotes(db: DB, vault: string, prepare: () => NoteChange[]): void {
  db.transaction(() => {
    const changes = prepare()
    const originals = changes.map(c => existsSync(c.abs) ? readFileSync(c.abs, 'utf8') : null)
    const applied: number[] = []
    try {
      for (const [i, c] of changes.entries()) {
        replaceFile(c.abs, c.raw)
        applied.push(i)
        if (c.raw == null) deleteNote(db, c.rel)
        else indexFile(db, vault, c.rel)
      }
    } catch (error) {
      const errors: unknown[] = [error]
      for (const i of applied.reverse()) {
        try { replaceFile(changes[i].abs, originals[i]) } catch (restoreError) { errors.push(restoreError) }
      }
      if (errors.length > 1) throw new AggregateError(errors, 'Note write failed and rollback needs manual recovery')
      throw error
    }
  }).immediate()
}

function replaceFile(abs: string, raw: string | null): void {
  if (raw == null) { unlinkSync(abs); return }
  mkdirSync(dirname(abs), { recursive: true })
  const temp = `${abs}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, raw, { flag: 'wx', mode: existsSync(abs) ? statSync(abs).mode & 0o777 : 0o666 })
    renameSync(temp, abs)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

/** Keep structured history paths valid when an existing successor moves into the archive. */
export function retargetHistory(
  db: DB,
  safeRel: (path: string) => { rel: string; abs: string },
  moves: Map<string, string>,
): NoteChange[] {
  if (!moves.size) return []
  const changes: NoteChange[] = []
  const rows = db.prepare(`SELECT path FROM notes
    WHERE json_extract(frontmatter, '$.superseded_by') IS NOT NULL
       OR json_extract(frontmatter, '$.supersedes') IS NOT NULL`).all() as { path: string }[]
  for (const { path } of rows) {
    if (moves.has(path)) continue
    const target = safeRel(path)
    if (!existsSync(target.abs)) continue
    const parsed = parseFrontmatter(readFileSync(target.abs, 'utf8'))
    const fm = parsed.frontmatter
    let changed = false
    if (typeof fm.superseded_by === 'string' && moves.has(fm.superseded_by)) {
      fm.superseded_by = moves.get(fm.superseded_by)
      changed = true
    }
    if (Array.isArray(fm.supersedes)) fm.supersedes = fm.supersedes.map(p => {
      if (typeof p !== 'string' || !moves.has(p)) return p
      changed = true
      return moves.get(p)!
    })
    if (changed) changes.push({ ...target, raw: stringifyFrontmatter(parsed.content, fm) })
  }
  return changes
}
