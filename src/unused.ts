/**
 * Vault drift detection for the memory_unused MCP tool.
 *
 * Mirrors src/status.ts (vaultStatus): the SQL-in-transaction is business
 * logic, not MCP glue. Pure (no MCP types) so it can be unit-tested directly.
 */
import type { DB } from './db.ts'
import { folderPat } from './filters.ts'

export interface UnusedNote {
  path: string
  title: string
  mtime: number
  mtime_days: number
  confidence: number | null
  inlinks: number
}

export interface UnusedResult {
  scanned: number
  matched: number
  notes: UnusedNote[]
}

export interface UnusedOpts {
  mtimeDays?: number
  limit?: number
  folder?: string
}

/**
 * One-call drift report: notes that are unpinned, not under archive/, older
 * than `mtimeDays`, and have zero wikilink inlinks — prime archive candidates.
 * Single transaction so scanned/matched/notes are internally consistent.
 *
 * `inlinks` is hardcoded 0: the NOT EXISTS predicate guarantees every returned
 * note has zero wikilink inlinks, so a redundant per-row subquery is wasted work.
 * NOT EXISTS short-circuits on the first edge (the `edges_wikilink_dst` partial
 * index covers the lookup).
 */
export function findUnused(db: DB, opts: UnusedOpts = {}): UnusedResult {
  const mtimeDays = opts.mtimeDays ?? 30
  const limit = opts.limit ?? 50
  const now = Date.now()
  const cutoff = now - mtimeDays * 86_400_000
  const folderClause = opts.folder ? ` AND path LIKE ? ESCAPE '\\'` : ''
  const folderParams = opts.folder ? [folderPat(opts.folder)] : []

  // predicate: unpinned, not archived, older than cutoff, zero wikilink inlinks
  const predicate = `pinned = 0 AND path NOT LIKE 'archive/%' AND mtime < ?` +
    ` AND NOT EXISTS (SELECT 1 FROM edges WHERE dst = notes.path AND type = 'wikilink')` +
    folderClause

  return db.transaction(() => {
    const scanned = (
      db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE 1=1${folderClause}`).get(...folderParams) as { c: number }
    ).c
    const matched = (
      db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE ${predicate}`).get(cutoff, ...folderParams) as { c: number }
    ).c
    const rows = db
      .prepare(
        // mtime_days uses `now` (age), not `cutoff`; predicate uses `cutoff`
        `SELECT path, title, mtime,
                CAST((? - mtime) / 86400000 AS INTEGER) AS mtime_days,
                json_extract(frontmatter, '$.confidence') AS confidence
         FROM notes WHERE ${predicate}
         ORDER BY mtime ASC LIMIT ?`,
      )
      .all(now, cutoff, ...folderParams, limit) as {
        path: string
        title: string
        mtime: number
        mtime_days: number
        confidence: number | null
      }[]
    return {
      scanned,
      matched,
      notes: rows.map(r => ({ ...r, inlinks: 0 })),
    }
  })()
}
