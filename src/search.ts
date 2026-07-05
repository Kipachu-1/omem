import { getMeta, type DB } from './db.ts'
import { bufToVec, dot, type Embedder } from './embed.ts'

export interface SearchOpts {
  limit?: number
  folder?: string
  tags?: string[]
  after?: number // ms epoch, inclusive
  before?: number
  expandGraph?: boolean
  embedder?: Embedder | null
  kinds?: string[] // restrict to these memory kinds (decision|gotcha|convention|fact|meeting|log)
  pinned?: boolean // only pinned notes
}

export type MatchType = 'vector' | 'keyword' | 'both' | 'graph'

export interface SearchResult {
  notePath: string
  title: string
  heading: string | null
  anchor: string | null
  text: string
  score: number
  matchType: MatchType
}

const RRF_K = 60
const LEG = 20
const SEEDS = 10
const PER_SEED = 5 // cap so a hub/MOC note can't flood expansion
const GRAPH_CAP = 15
const GRAPH_DISCOUNT = 0.5
const PER_NOTE = 2

export async function search(db: DB, query: string, opts: SearchOpts = {}): Promise<SearchResult[]> {
  const limit = opts.limit ?? 10
  const allowed = allowedPaths(db, opts)
  if (allowed && allowed.size === 0) return []

  // keyword leg: FTS5/BM25, tokens quoted and OR-joined so FTS syntax can't break
  let ftsIds: number[] = []
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (tokens.length) {
    const match = tokens.map(t => `"${t}"`).join(' OR ')
    // with filters active, scan all matches — a LIMIT window before filtering can starve in-scope hits
    const rows = db
      .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank ${allowed ? '' : 'LIMIT 100'}`)
      .all(match) as { rowid: number }[]
    ftsIds = filterAllowed(db, rows.map(r => r.rowid), allowed).slice(0, LEG)
  }

  // vector leg: brute-force dot product over all embedded chunks
  // ponytail: full scan per query, ~20ms at 30k chunks; cache the matrix in memory if this ever serves at scale
  let vecIds: number[] = []
  let queryVec: Float32Array | null = null
  const recorded = getMeta(db, 'embed_model')
  if (opts.embedder && (!recorded || recorded === opts.embedder.model)) {
    try {
      queryVec = (await opts.embedder.embed([query], 'query'))[0]
    } catch {
      // model unavailable: degrade to keyword-only
    }
  }
  if (queryVec) {
    const rows = db
      .prepare('SELECT id, note_path, embedding FROM chunks WHERE embedding IS NOT NULL')
      .all() as { id: number; note_path: string; embedding: Buffer }[]
    vecIds = rows
      .filter(r => !allowed || allowed.has(r.note_path))
      .map(r => ({ id: r.id, sim: dot(queryVec!, bufToVec(r.embedding)) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, LEG)
      .map(r => r.id)
  }

  // reciprocal rank fusion
  const fused = new Map<number, { score: number; legs: number }>() // legs: 1=vector 2=keyword
  const addLeg = (ids: number[], bit: number) =>
    ids.forEach((id, rank) => {
      const e = fused.get(id) ?? { score: 0, legs: 0 }
      e.score += 1 / (RRF_K + rank + 1)
      e.legs |= bit
      fused.set(id, e)
    })
  addLeg(vecIds, 1)
  addLeg(ftsIds, 2)

  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score)
  const info = chunkInfo(db, ranked.map(([id]) => id))

  type Entry = { id: number; score: number; matchType: MatchType }
  const entries: Entry[] = ranked.map(([id, e]) => ({
    id,
    score: e.score,
    matchType: e.legs === 3 ? 'both' : e.legs === 1 ? 'vector' : 'keyword',
  }))

  // graph expansion: 1-hop wikilink neighbors of the top fused notes
  if (opts.expandGraph !== false && entries.length) {
    const resultPaths = new Set(entries.map(e => info.get(e.id)!.note_path))
    const seeds = new Map<string, number>() // note path -> best fused score
    for (const e of entries.slice(0, SEEDS)) {
      const p = info.get(e.id)!.note_path
      if (!seeds.has(p)) seeds.set(p, e.score)
    }
    const neighStmt = db.prepare(
      `SELECT dst AS p FROM edges WHERE src_path = ? AND type = 'wikilink' AND resolved = 1
       UNION
       SELECT src_path AS p FROM edges WHERE dst = ? AND type = 'wikilink' AND resolved = 1`,
    )
    const added = new Set<string>()
    outer: for (const [seedPath, seedScore] of seeds) {
      let accepted = 0 // only actual additions consume the per-seed budget
      for (const { p } of neighStmt.all(seedPath, seedPath) as { p: string }[]) {
        if (accepted >= PER_SEED) break
        if (resultPaths.has(p) || added.has(p) || (allowed && !allowed.has(p))) continue
        const best = bestChunk(db, p, queryVec)
        if (!best) continue
        added.add(p)
        accepted++
        entries.push({ id: best, score: seedScore * GRAPH_DISCOUNT, matchType: 'graph' })
        if (added.size >= GRAPH_CAP) break outer
      }
    }
    for (const [id, row] of chunkInfo(db, entries.filter(e => !info.has(e.id)).map(e => e.id))) info.set(id, row)
  }

  // recency boost for agent memories: newer supersedes older
  // ponytail: memory/ only, fixed half-life ~30d; make configurable when someone actually asks
  // kind/pinned boost: pinned decisions beat same-score logs by ~2-3 ranks without junk-sticking forever
  const HIGH_RANK_KINDS = new Set(['decision', 'gotcha', 'convention'])
  const now = Date.now()
  for (const e of entries) {
    const row = info.get(e.id)!
    if (row.note_path.startsWith('memory/')) {
      const ageDays = Math.max(0, (now - row.mtime) / 86_400_000)
      e.score *= 1 + 0.3 * Math.exp(-ageDays / 30)
    }
    if (row.pinned === 1) e.score *= 1.4
    if (row.kind && HIGH_RANK_KINDS.has(row.kind)) e.score *= 1.2
  }

  entries.sort((a, b) => b.score - a.score)
  const perNote = new Map<string, number>()
  const out: SearchResult[] = []
  for (const e of entries) {
    const row = info.get(e.id)!
    const n = perNote.get(row.note_path) ?? 0
    if (n >= PER_NOTE) continue
    perNote.set(row.note_path, n + 1)
    out.push({
      notePath: row.note_path,
      title: row.title,
      heading: row.heading,
      anchor: row.anchor,
      text: row.text,
      score: e.score,
      matchType: e.matchType,
    })
    if (out.length >= limit) break
  }
  return out
}

/** Pre-ranking filters -> allowed note paths, or null when unfiltered. */
function allowedPaths(db: DB, opts: SearchOpts): Set<string> | null {
  if (
    !opts.folder &&
    !opts.tags?.length &&
    opts.after == null &&
    opts.before == null &&
    !opts.kinds?.length &&
    opts.pinned == null
  )
    return null
  const where: string[] = []
  const params: unknown[] = []
  if (opts.folder) {
    where.push("path LIKE ? ESCAPE '\\'")
    params.push(opts.folder.replace(/\/+$/, '').replace(/[\\%_]/g, m => '\\' + m) + '/%')
  }
  if (opts.after != null) (where.push('mtime >= ?'), params.push(opts.after))
  if (opts.before != null) (where.push('mtime <= ?'), params.push(opts.before))
  if (opts.pinned) where.push('pinned = 1')
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`)
    params.push(...opts.kinds)
  }
  for (const tag of opts.tags ?? []) {
    // nested tags: "project" matches "project/canvas"
    where.push(
      "EXISTS (SELECT 1 FROM edges e WHERE e.src_path = notes.path AND e.type = 'tag' AND (e.dst = ? OR e.dst LIKE ? ESCAPE '\\'))",
    )
    const t = tag.replace(/^#/, '')
    params.push(t, t.replace(/[\\%_]/g, m => '\\' + m) + '/%')
  }
  const rows = db.prepare(`SELECT path FROM notes WHERE ${where.join(' AND ')}`).all(...params) as { path: string }[]
  return new Set(rows.map(r => r.path))
}

function filterAllowed(db: DB, ids: number[], allowed: Set<string> | null): number[] {
  if (!allowed || !ids.length) return ids
  const rows = db
    .prepare(`SELECT id, note_path FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { id: number; note_path: string }[]
  const pathOf = new Map(rows.map(r => [r.id, r.note_path]))
  return ids.filter(id => allowed.has(pathOf.get(id) ?? ''))
}

interface ChunkRow {
  id: number
  note_path: string
  title: string
  heading: string | null
  anchor: string | null
  text: string
  mtime: number
  kind: string | null
  pinned: number
}

function chunkInfo(db: DB, ids: number[]): Map<number, ChunkRow> {
  if (!ids.length) return new Map()
  const rows = db
    .prepare(
      `SELECT c.id, c.note_path, c.heading, c.anchor, c.text, n.title, n.mtime, n.kind, n.pinned
       FROM chunks c JOIN notes n ON n.path = c.note_path
       WHERE c.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as ChunkRow[]
  return new Map(rows.map(r => [r.id, r]))
}

/** Best chunk of a note for the query: max cosine when we have a query vector, else the first chunk. */
function bestChunk(db: DB, notePath: string, queryVec: Float32Array | null): number | null {
  const rows = db
    .prepare('SELECT id, embedding FROM chunks WHERE note_path = ? ORDER BY position')
    .all(notePath) as { id: number; embedding: Buffer | null }[]
  if (!rows.length) return null
  if (!queryVec) return rows[0].id
  let best = rows[0].id
  let bestSim = -Infinity
  for (const r of rows) {
    if (!r.embedding) continue
    const s = dot(queryVec, bufToVec(r.embedding))
    if (s > bestSim) (bestSim = s), (best = r.id)
  }
  return best
}
