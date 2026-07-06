import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import matter from 'gray-matter'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClientSeen, setClientSeen } from '../../db.ts'
import { topSimilar } from '../../search.ts'
import { withUsage, kindSchema, SINCE_MS, folderPat } from '../shared.ts'
import type { ToolCtx } from '../ctx.ts'

/** Register read/browse tools: memory_get_note, memory_graph, memory_list, memory_recent, memory_status. */
export function registerBrowseTools(server: McpServer, ctx: ToolCtx): void {
  const { db, embedder, deepLink, safeRel, json, getClientName } = ctx

  server.registerTool(
    'memory_get_note',
    {
      title: 'Read a full note',
      description: 'Full content, frontmatter, and backlinks of one vault note by path (as returned by memory_search).',
      inputSchema: { path: z.string().describe("vault-relative path, e.g. 'islands/y-agents/README.md'") },
      annotations: { readOnlyHint: true },
    },
    async a =>
      withUsage('memory_get_note', a, async () => {
        const { rel, abs } = safeRel(a.path)
        if (!existsSync(abs)) throw new Error(`note not found: ${rel}`)
        const raw = readFileSync(abs, 'utf8')
        let frontmatter: unknown = {}
        let content = raw
        try {
          const fm = matter(raw)
          if (fm.data && typeof fm.data === 'object') (frontmatter = fm.data), (content = fm.content)
        } catch {
          // malformed frontmatter: return the raw file
        }
        const backlinks = (
          db
            .prepare("SELECT DISTINCT src_path FROM edges WHERE dst = ? AND type = 'wikilink' AND resolved = 1")
            .all(rel) as { src_path: string }[]
        ).map(r => r.src_path)
        return json({ path: rel, frontmatter, content, backlinks, link: deepLink(rel) })
      }),
  )

  server.registerTool(
    'memory_graph',
    {
      title: 'Browse the note neighborhood',
      description:
        "Return a note's local graph: outgoing wikilinks, incoming backlinks, tag neighbors, " +
        'and embedding-similar notes. One call replaces N get_note round-trips when assembling ' +
        'a topic. Use when you already have a note path and want its neighborhood, NOT when you ' +
        'have a query (use memory_search or memory_recall for that).',
      inputSchema: {
        path: z.string().describe('vault-relative path of the seed note'),
        outgoing: z.boolean().optional().describe('include outgoing wikilinks, default true'),
        incoming: z.boolean().optional().describe('include incoming backlinks, default true'),
        byTag: z.boolean().optional().describe('include notes sharing any tag, default false'),
        byEmbedding: z.boolean().optional().describe('include top-k embedding-similar notes, default false'),
        k: z.number().int().min(1).max(3).optional().describe('hops for outgoing/incoming, default 1'),
        limit: z.number().int().min(1).max(100).optional().describe('cap on total neighbors, default 30'),
      },
      annotations: { readOnlyHint: true },
    },
    async a =>
      withUsage('memory_graph', a, async () => {
      const { rel } = safeRel(a.path)
      const seedRow = db.prepare('SELECT path, title, kind, pinned FROM notes WHERE path = ?').get(rel) as
        | { path: string; title: string; kind: string | null; pinned: number }
        | undefined
      if (!seedRow) throw new Error(`note not found: ${rel}`)
      const seed = { path: seedRow.path, title: seedRow.title, kind: seedRow.kind, pinned: seedRow.pinned }
      const k = a.k ?? 1
      const limit = a.limit ?? 30
      const wantOut = a.outgoing !== false
      const wantIn = a.incoming !== false
      const wantTag = a.byTag === true
      const wantEmb = a.byEmbedding === true

      // per-direction visited sets keep k-hop traversal independent; a final cross-list
      // dedup (outgoing > incoming > byTag > byEmbedding) handles the "listed once" rule.
      const outgoing: { path: string; hop: number }[] = []
      const incoming: { path: string; hop: number }[] = []
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

      if (wantEmb) {
        const ch = db.prepare('SELECT text FROM chunks WHERE note_path = ? ORDER BY position LIMIT 1').get(seed.path) as
          | { text: string }
          | undefined
        const seedText = ch?.text ?? seed.title
        // reuse the dedup-on-write cosine helper (topSimilar, OME-10) — same note-level
        // best-score shape; not a shared `search()` helper because search() ranks chunks (RRF)
        const sim = (await topSimilar(db, embedder, seedText, limit)).filter(r => r.note_path !== seed.path)
        byEmbedding = sim.map(r => ({ path: r.note_path, title: r.title, score: r.score }))
      }

      // cross-list dedup: outgoing first, then incoming, byTag, byEmbedding
      const claimed = new Set<string>([seed.path])
      const dedup = <T extends { path: string }>(arr: T[]): T[] => arr.filter(e => !claimed.has(e.path) && (claimed.add(e.path), true))
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

      return json({
        seed,
        outgoing: outFinal.map(e => ({ path: e.path, title: titleMap.get(e.path) ?? e.path, hop: e.hop, score: 1.0 })),
        incoming: inFinal.map(e => ({ path: e.path, title: titleMap.get(e.path) ?? e.path, hop: e.hop, score: 1.0 })),
        byTag: tagFinal.map(e => ({ path: e.path, title: e.title, sharedTags: e.sharedTags, link: deepLink(e.path) })),
        byEmbedding: embFinal.map(e => ({ path: e.path, title: e.title, score: e.score, link: deepLink(e.path) })),
        totalNodes: total,
      })
      }),
  )

  server.registerTool(
    'memory_recent',
    {
      title: 'Recently modified notes',
      description:
        "Most recently modified vault notes — 'what have we been working on'. " +
        'Pass since:"lastSeen" to get only notes modified since THIS client last called memory_recent ' +
        '(first call from a client falls back to 24h and seeds the watermark). ' +
        'since:"1h" | "1d" | "7d" resolve to a rolling window with no per-client state. ' +
        'When since is set, the response carries sinceResolved (ISO epoch, or "fallback-24h" on the first lastSeen call).',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('default 10'),
        folder: z.string().optional().describe('restrict to a folder prefix'),
        since: z
          .enum(['lastSeen', '1h', '1d', '7d'])
          .optional()
          .describe('rolling window; "lastSeen" uses a per-client watermark seeded after each call'),
      },
      annotations: { readOnlyHint: true },
    },
    async a =>
      withUsage('memory_recent', a, async () => {
        const where: string[] = []
        const params: unknown[] = []
        if (a.folder) where.push("path LIKE ? ESCAPE '\\'"), params.push(folderPat(a.folder))

        let sinceResolved: string | undefined
        if (a.since) {
          const now = Date.now()
          let cutoff: number
          if (a.since === 'lastSeen') {
            const client = getClientName()
            const last = getClientSeen(db, client)
            if (last === undefined) {
              cutoff = now - 86_400_000
              sinceResolved = 'fallback-24h'
            } else {
              cutoff = last
              sinceResolved = new Date(last).toISOString()
            }
            // seed/advance the watermark AFTER computing the cutoff from the old value,
            // so a client always sees notes that existed when it called
            setClientSeen(db, client, now)
          } else {
            cutoff = now - SINCE_MS[a.since]
            sinceResolved = new Date(cutoff).toISOString()
          }
          where.push('mtime >= ?'), params.push(cutoff)
        }

        const rows = db
          .prepare(
            `SELECT path, title, mtime FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY mtime DESC LIMIT ?`,
          )
          .all(...params, a.limit ?? 10) as { path: string; title: string; mtime: number }[]
        const out: { notes: { path: string; title: string; mtime: number; modified: string; link: string }[]; sinceResolved?: string } = {
          notes: rows.map(r => ({ ...r, modified: new Date(r.mtime).toISOString(), link: deepLink(r.path) })),
        }
        if (sinceResolved !== undefined) out.sinceResolved = sinceResolved
        return json(out)
      }),
  )

  server.registerTool(
    'memory_list',
    {
      title: 'List notes',
      description:
        'Enumerate vault notes by folder and/or tag — browse an island without needing a search query. Sorted by path.',
      inputSchema: {
        folder: z.string().optional().describe("folder prefix, e.g. 'islands/y-agents'"),
        tag: z.string().optional().describe('require this tag (nested tags match by prefix)'),
        limit: z.number().int().min(1).max(500).optional().describe('default 100'),
        pinned: z.boolean().optional().describe('only pinned notes'),
        kinds: z.array(kindSchema).optional().describe('restrict to these memory kinds'),
      },
      annotations: { readOnlyHint: true },
    },
    async a =>
      withUsage('memory_list', a, async () => {
        const where: string[] = []
        const params: unknown[] = []
        if (a.folder) where.push("path LIKE ? ESCAPE '\\'"), params.push(folderPat(a.folder))
        if (a.pinned) where.push('pinned = 1')
        if (a.kinds?.length) {
          where.push(`kind IN (${a.kinds.map(() => '?').join(',')})`)
          params.push(...a.kinds)
        }
        if (a.tag) {
          where.push(
            "EXISTS (SELECT 1 FROM edges e WHERE e.src_path = notes.path AND e.type = 'tag' AND (e.dst = ? OR e.dst LIKE ? ESCAPE '\\'))",
          )
          params.push(a.tag, a.tag.replace(/[\\%_]/g, m => '\\' + m) + '/%')
        }
        const rows = db
          .prepare(
            `SELECT path, title, mtime FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY path LIMIT ?`,
          )
          .all(...params, a.limit ?? 100) as { path: string; title: string; mtime: number }[]
        return json(rows.map(r => ({ path: r.path, title: r.title, modified: new Date(r.mtime).toISOString() })))
      }),
  )

  server.registerTool(
    'memory_status',
    {
      title: 'Vault status snapshot',
      description:
        'Cheap one-call orientation: vault size, last modification, top folders, top tags, ' +
        'top kinds, pinned/archived counts, and a few most-recent notes. Use on a fresh session to decide ' +
        'whether memory is worth querying, and what to query.',
      inputSchema: {}, // no inputs
      annotations: { readOnlyHint: true },
    },
    async () =>
      withUsage('memory_status', {}, async () => {
        // single transaction so the snapshot is internally consistent
        const snap = db.transaction(() => {
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

        return json({
          notes: snap.notes,
          chunks: snap.chunks,
          embedded: snap.embedded,
          lastModified: snap.maxMtime == null ? null : new Date(snap.maxMtime).toISOString(),
          topFolders: snap.topFolders,
          topTags: snap.topTags,
          pinned: snap.pinned,
          archived: snap.archived,
          topKinds: snap.topKinds,
          recent: snap.recent.map(r => ({
            path: r.path,
            title: r.title,
            modified: new Date(r.mtime).toISOString(),
            link: deepLink(r.path),
          })),
        })
      }),
  )
}
