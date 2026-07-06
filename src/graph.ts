/**
 * K-hop wikilink graph traversal for the memory_graph MCP tool.
 *
 * Extracted from browse.ts — the 152-line memory_graph handler was a god fn
 * mixing 4 traversal modes (outgoing/incoming/byTag/byEmbedding) + BFS visited
 * sets + cross-list dedup + limit trimming. This module is pure (no MCP types).
 */
import type { DB } from './db.ts'
import type { Embedder } from './embed.ts'
import { topSimilar } from './search.ts'

export interface GraphOpts {
  outgoing?: boolean
  incoming?: boolean
  byTag?: boolean
  byEmbedding?: boolean
  k?: number
  limit?: number
}

export interface GraphResult {
  seed: { path: string; title: string; kind: string | null; pinned: number }
  outgoing: { path: string; title: string; hop: number; score: number }[]
  incoming: { path: string; title: string; hop: number; score: number }[]
  byTag: { path: string; title: string; sharedTags: string[] }[]
  byEmbedding: { path: string; title: string; score: number }[]
  totalNodes: number
}

interface HopEntry {
  path: string
  hop: number
}

/**
 * One-call note neighborhood: outgoing wikilinks, incoming backlinks,
 * tag neighbors, and embedding-similar notes. k-hop traversal uses
 * per-direction visited sets (independent BFS); a final cross-list dedup
 * (outgoing > incoming > byTag > byEmbedding) enforces "each path listed once",
 * and `limit` caps the total union by trimming lowest-priority lists first.
 */
export async function noteGraph(
  db: DB,
  embedder: Embedder | undefined,
  rel: string,
  deepLink: (p: string) => string,
  opts: GraphOpts = {},
): Promise<GraphResult> {
  const seedRow = db.prepare('SELECT path, title, kind, pinned FROM notes WHERE path = ?').get(rel) as
    | { path: string; title: string; kind: string | null; pinned: number }
    | undefined
  if (!seedRow) throw new Error(`note not found: ${rel}`)
  const seed = { path: seedRow.path, title: seedRow.title, kind: seedRow.kind, pinned: seedRow.pinned }
  const k = opts.k ?? 1
  const limit = opts.limit ?? 30
  const wantOut = opts.outgoing !== false
  const wantIn = opts.incoming !== false
  const wantTag = opts.byTag === true
  const wantEmb = opts.byEmbedding === true

  const outgoing: HopEntry[] = []
  const incoming: HopEntry[] = []
  const byTag: { path: string; title: string; sharedTags: string[] }[] = []
  let byEmbedding: { path: string; title: string; score: number }[] = []

  if (wantOut) {
    const seen = new Set<string>([seed.path])
    let frontier = [seed.path]
    for (let hop = 1; hop <= k; hop++) {
      if (!frontier.length) break
      const ph = frontier.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT DISTINCT e.dst AS path FROM edges e JOIN notes n ON n.path = e.dst
           WHERE e.src_path IN (${ph}) AND e.type = 'wikilink' AND e.resolved = 1`,
        )
        .all(...frontier) as { path: string }[]
      const next: string[] = []
      for (const r of rows) {
        if (seen.has(r.path)) continue
        seen.add(r.path)
        outgoing.push({ path: r.path, hop })
        next.push(r.path)
      }
      frontier = next
    }
  }

  if (wantIn) {
    const seen = new Set<string>([seed.path])
    let frontier = [seed.path]
    for (let hop = 1; hop <= k; hop++) {
      if (!frontier.length) break
      const ph = frontier.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT DISTINCT e.src_path AS path FROM edges e JOIN notes n ON n.path = e.src_path
           WHERE e.dst IN (${ph}) AND e.type = 'wikilink' AND e.resolved = 1`,
        )
        .all(...frontier) as { path: string }[]
      const next: string[] = []
      for (const r of rows) {
        if (seen.has(r.path)) continue
        seen.add(r.path)
        incoming.push({ path: r.path, hop })
        next.push(r.path)
      }
      frontier = next
    }
  }

  if (wantTag) {
    const rows = db
      .prepare(
        `SELECT n.path AS path, n.title AS title, GROUP_CONCAT(e.dst) AS sharedTags
         FROM edges e JOIN notes n ON n.path = e.src_path
         WHERE e.type = 'tag'
           AND e.dst IN (SELECT dst FROM edges WHERE src_path = ? AND type = 'tag')
           AND n.path != ?
         GROUP BY n.path
         ORDER BY n.path`,
      )
      .all(seed.path, seed.path) as { path: string; title: string; sharedTags: string }[]
    byTag.push(...rows.map(r => ({ path: r.path, title: r.title, sharedTags: r.sharedTags.split(',') })))
  }

  if (wantEmb && embedder) {
    const ch = db.prepare('SELECT text FROM chunks WHERE note_path = ? ORDER BY position LIMIT 1').get(seed.path) as
      | { text: string }
      | undefined
    const seedText = ch?.text ?? seed.title
    const sim = (await topSimilar(db, embedder, seedText, limit)).filter(r => r.note_path !== seed.path)
    byEmbedding = sim.map(r => ({ path: r.note_path, title: r.title, score: r.score }))
  }

  // cross-list dedup: outgoing first, then incoming, byTag, byEmbedding
  const claimed = new Set<string>([seed.path])
  const dedup = <T extends { path: string }>(arr: T[]): T[] =>
    arr.filter(e => !claimed.has(e.path) && (claimed.add(e.path), true))
  const outFinal = dedup(outgoing)
  const inFinal = dedup(incoming)
  const tagFinal = dedup(byTag)
  const embFinal = dedup(byEmbedding)

  // batch-fetch titles for outgoing/incoming (byTag/byEmbedding already carry them)
  const needTitles = [...outFinal, ...inFinal].map(e => e.path)
  const titleMap = new Map<string, string>()
  if (needTitles.length) {
    const ph = needTitles.map(() => '?').join(',')
    const rows = db.prepare(`SELECT path, title FROM notes WHERE path IN (${ph})`).all(...needTitles) as {
      path: string
      title: string
    }[]
    for (const r of rows) titleMap.set(r.path, r.title)
  }

  // `limit` caps the total union: trim lowest-priority lists first (byEmbedding, byTag, incoming, outgoing)
  let total = outFinal.length + inFinal.length + tagFinal.length + embFinal.length
  const trim = (arr: unknown[]): void => {
    while (total > limit && arr.length) {
      arr.pop()
      total--
    }
  }
  trim(embFinal)
  trim(tagFinal)
  trim(inFinal)
  trim(outFinal)

  return {
    seed,
    outgoing: outFinal.map(e => ({ path: e.path, title: titleMap.get(e.path) ?? e.path, hop: e.hop, score: 1.0 })),
    incoming: inFinal.map(e => ({ path: e.path, title: titleMap.get(e.path) ?? e.path, hop: e.hop, score: 1.0 })),
    byTag: tagFinal.map(e => ({ path: e.path, title: e.title, sharedTags: e.sharedTags, link: deepLink(e.path) })),
    byEmbedding: embFinal.map(e => ({ path: e.path, title: e.title, score: e.score, link: deepLink(e.path) })),
    totalNodes: total,
  }
}
