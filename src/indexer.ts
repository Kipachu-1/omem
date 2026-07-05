import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseNote, type ParsedNote } from './parser.ts'
import { getMeta, setMeta, type DB } from './db.ts'
import { vecToBuf, type Embedder } from './embed.ts'

export const SKIP_DIRS = new Set(['.obsidian', '.trash', '.omem', 'node_modules'])

export function walkVault(vault: string): string[] {
  const out: string[] = []
  const rec = (rel: string) => {
    for (const e of readdirSync(join(vault, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) rec(relPath)
      else if (e.name.toLowerCase().endsWith('.md')) out.push(relPath)
    }
  }
  rec('')
  return out.sort()
}

/** Index one file. Returns false if unchanged (hash match). */
export function indexFile(db: DB, vault: string, relPath: string): boolean {
  const abs = join(vault, relPath)
  const raw = readFileSync(abs, 'utf8')
  const hash = createHash('sha256').update(raw).digest('hex')
  const existing = db.prepare('SELECT hash FROM notes WHERE path = ?').get(relPath) as { hash: string } | undefined
  if (existing?.hash === hash) return false
  const mtime = Math.floor(statSync(abs).mtimeMs)
  applyNote(db, relPath, parseNote(relPath, raw), hash, mtime)
  return true
}

function applyNote(db: DB, relPath: string, parsed: ParsedNote, hash: string, mtime: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE note_path = ?)').run(relPath)
    db.prepare('DELETE FROM chunks WHERE note_path = ?').run(relPath)
    db.prepare('DELETE FROM edges WHERE src_path = ?').run(relPath)
    db.prepare(
      `INSERT INTO notes(path, title, frontmatter, mtime, hash) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET title = excluded.title, frontmatter = excluded.frontmatter,
                                       mtime = excluded.mtime, hash = excluded.hash`,
    ).run(relPath, parsed.title, JSON.stringify(parsed.frontmatter), mtime, hash)

    const insChunk = db.prepare('INSERT INTO chunks(note_path, heading, anchor, position, text) VALUES (?, ?, ?, ?, ?)')
    const insFts = db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)')
    for (const c of parsed.chunks) {
      const id = insChunk.run(relPath, c.heading, c.anchor, c.position, c.text).lastInsertRowid
      insFts.run(id, c.text)
    }

    // every parsed link becomes exactly one edge (even self-resolving ones):
    // special cases here break the incremental == rebuild invariant
    const insEdge = db.prepare('INSERT OR IGNORE INTO edges(src_path, dst, type, resolved, raw) VALUES (?, ?, ?, ?, ?)')
    for (const target of parsed.wikilinks) {
      const resolved = resolveLink(db, target)
      insEdge.run(relPath, resolved ?? target, 'wikilink', resolved ? 1 : 0, target)
    }
    for (const tag of parsed.tags) insEdge.run(relPath, tag, 'tag', 1, tag)

    reResolve(db, relPath, parsed.title)
  })()
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, m => '\\' + m)
}

/** Obsidian-style precedence: exact path, then basename, then title. Case-insensitive. */
function resolveLink(db: DB, target: string): string | null {
  const t = target.toLowerCase().replace(/\.md$/, '')
  const row = db
    .prepare(
      `SELECT path FROM notes
       WHERE lower(path) = ? || '.md'
          OR lower(path) LIKE '%/' || ? || '.md' ESCAPE '\\'
          OR lower(title) = ?
       ORDER BY (lower(path) = ? || '.md') DESC,
                (lower(path) LIKE '%/' || ? || '.md' ESCAPE '\\') DESC,
                length(path) ASC, path ASC
       LIMIT 1`,
    )
    .get(t, likeEscape(t), t, t, likeEscape(t)) as { path: string } | undefined
  return row?.path ?? null
}

/**
 * Re-resolve wikilink edges after a note is (re)indexed, so incremental state
 * converges to what a rebuild would produce: unresolved links heal when their
 * target appears, resolved links move when a better candidate appears, and
 * links resolved via a title that changed fall back to unresolved.
 *
 * Performance: only fetches edges whose `raw` could possibly refer to this note
 * (via the lowercased basename / path / title / path-suffix matches below) plus
 * edges already resolved to this note — backed by the `edges_wikilink_lraw` and
 * `edges_wikilink_dst` partial indexes. The JS filter then applies the exact
 * `refersHere`/`pointsHere` check, so the query is a strict superset of matches
 * (over-fetch is safe; under-fetch would silently break convergence).
 */
function reResolve(db: DB, notePath: string, title: string): void {
  const lowerPath = notePath.toLowerCase().replace(/\.md$/, '')
  const base = lowerPath.split('/').pop()!
  const lowerTitle = title.toLowerCase()

  // candidate d-values (d = lower(raw) with a trailing .md stripped) that the
  // refersHere check can match: basename, full path, title, and every path
  // suffix (for the lowerPath.endsWith('/' + d) branch, which only adds
  // candidates beyond base/lowerPath for paths with 3+ segments).
  const dVals = new Set<string>([base, lowerPath, lowerTitle])
  const segs = lowerPath.split('/')
  for (let i = 1; i < segs.length - 1; i++) dVals.add(segs.slice(i).join('/'))
  // raw may or may not carry a trailing .md; cover both spellings per d-value.
  const cands: string[] = []
  for (const d of dVals) {
    cands.push(d)
    cands.push(d + '.md')
  }

  const rows = db
    .prepare(
      `SELECT src_path, dst, resolved, raw FROM edges
       WHERE type = 'wikilink'
         AND (lower(raw) IN (${cands.map(() => '?').join(',')}) OR (resolved = 1 AND dst = ?))`,
    )
    .all(...cands, notePath) as {
    src_path: string
    dst: string
    resolved: number
    raw: string
  }[]
  const upd = db.prepare("UPDATE edges SET dst = ?, resolved = ? WHERE src_path = ? AND raw = ? AND type = 'wikilink'")
  for (const r of rows) {
    if (r.src_path === notePath) continue // own outgoing edges were just freshly resolved
    const d = r.raw.toLowerCase().replace(/\.md$/, '')
    const refersHere = d === base || d === lowerPath || d === lowerTitle || lowerPath.endsWith('/' + d)
    const pointsHere = r.resolved === 1 && r.dst === notePath
    if (!refersHere && !pointsHere) continue
    const target = resolveLink(db, r.raw)
    const dst = target ?? r.raw
    const resolved = target ? 1 : 0
    if (dst !== r.dst || resolved !== r.resolved) upd.run(dst, resolved, r.src_path, r.raw)
  }
}

export function deleteNote(db: DB, relPath: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE note_path = ?)').run(relPath)
    db.prepare('DELETE FROM notes WHERE path = ?').run(relPath) // chunks cascade via FK
    db.prepare('DELETE FROM edges WHERE src_path = ?').run(relPath)
    // incoming links re-resolve against the remaining notes (next-best candidate or raw unresolved),
    // so incremental state == rebuild state
    const incoming = db
      .prepare("SELECT src_path, raw FROM edges WHERE dst = ? AND type = 'wikilink'")
      .all(relPath) as { src_path: string; raw: string }[]
    db.prepare("DELETE FROM edges WHERE dst = ? AND type = 'wikilink'").run(relPath)
    const ins = db.prepare("INSERT OR IGNORE INTO edges(src_path, dst, type, resolved, raw) VALUES (?, ?, 'wikilink', ?, ?)")
    for (const e of incoming) {
      const t = resolveLink(db, e.raw)
      ins.run(e.src_path, t ?? e.raw, t ? 1 : 0, e.raw)
    }
  })()
}

export interface IndexStats {
  indexed: number
  removed: number
  unchanged: number
}

export function fullIndex(db: DB, vault: string): IndexStats {
  const files = walkVault(vault)
  // deletions first: a rename (delete+add) must free the old path's edges before
  // the new path indexes and re-resolution runs, or incremental diverges from rebuild
  const onDisk = new Set(files)
  const inDb = (db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(r => r.path)
  let removed = 0
  for (const p of inDb) if (!onDisk.has(p)) (deleteNote(db, p), removed++)
  let indexed = 0
  for (const f of files) {
    try {
      if (indexFile(db, vault, f)) indexed++
    } catch (e) {
      // file vanished between walk and read: the next run's deletion pass handles it
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return { indexed, removed, unchanged: files.length - indexed }
}

/** Embed every chunk with embedding IS NULL. Idempotent; NULL is the retry queue. */
export async function embedPending(db: DB, embedder: Embedder, batchSize = 16): Promise<number> {
  const recorded = getMeta(db, 'embed_model')
  if (recorded && recorded !== embedder.model)
    throw new Error(`index embedded with "${recorded}" but current model is "${embedder.model}" — run: omem rebuild`)

  const rows = db.prepare('SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id').all() as {
    id: number
    text: string
  }[]
  // text guard: sqlite reuses rowids, so a chunk replaced mid-flight must not get the old text's vector
  const upd = db.prepare('UPDATE chunks SET embedding = ? WHERE id = ? AND embedding IS NULL AND text = ?')
  let recordedNow = !!recorded
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const vecs = await embedder.embed(batch.map(r => r.text), 'doc')
    if (!recordedNow) {
      // record the model only after the first successful embed, or a failed run locks the index
      setMeta(db, 'embed_model', embedder.model)
      recordedNow = true
    }
    db.transaction(() => batch.forEach((r, j) => upd.run(vecToBuf(vecs[j]), r.id, r.text)))()
  }
  return rows.length
}
