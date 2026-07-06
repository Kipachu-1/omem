/**
 * Vault status snapshot query for the memory_status MCP tool.
 *
 * Extracted from browse.ts — the 80-line db.transaction snapshot
 * is business logic, not MCP glue. Pure (no MCP types).
 */
import type { DB } from './db.ts'

export interface VaultSnapshot {
  notes: number
  chunks: number
  embedded: number
  maxMtime: number | null
  pinned: number
  archived: number
  topKinds: { kind: string; count: number }[]
  topFolders: { folder: string; count: number }[]
  topTags: { tag: string; count: number }[]
  recent: { path: string; title: string; mtime: number }[]
}

/**
 * One-call orientation: vault size, last modification, top folders, top tags,
 * top kinds, pinned/archived counts, and a few most-recent notes.
 * Single transaction so the snapshot is internally consistent.
 */
export function vaultStatus(db: DB): VaultSnapshot {
  return db.transaction(() => {
    const notes = (db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c
    const chunks = (db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c
    const embedded = (
      db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL').get() as { c: number }
    ).c
    const maxMtime = (db.prepare('SELECT MAX(mtime) AS m FROM notes').get() as { m: number | null }).m
    const pinned = (db.prepare('SELECT COUNT(*) AS c FROM notes WHERE pinned = 1').get() as { c: number }).c
    const archived = (db.prepare("SELECT COUNT(*) AS c FROM notes WHERE path LIKE 'archive/%'").get() as { c: number }).c
    const topKinds = db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM notes WHERE kind IS NOT NULL
         GROUP BY kind ORDER BY count DESC, kind ASC LIMIT 10`,
      )
      .all() as { kind: string; count: number }[]
    const topFolders = db
      .prepare(
        `SELECT CASE WHEN instr(path, '/') = 0 THEN '' ELSE substr(path, 1, instr(path, '/') - 1) END AS folder,
                COUNT(*) AS count
         FROM notes GROUP BY folder ORDER BY count DESC, folder ASC LIMIT 10`,
      )
      .all() as { folder: string; count: number }[]
    const topTags = db
      .prepare(
        `SELECT dst AS tag, COUNT(DISTINCT src_path) AS count
         FROM edges WHERE type = 'tag'
         GROUP BY tag ORDER BY count DESC, tag ASC LIMIT 20`,
      )
      .all() as { tag: string; count: number }[]
    const recent = db
      .prepare('SELECT path, title, mtime FROM notes ORDER BY mtime DESC LIMIT 5')
      .all() as { path: string; title: string; mtime: number }[]
    return { notes, chunks, embedded, maxMtime, pinned, archived, topFolders, topTags, recent, topKinds }
  })()
}
