import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { withUsage } from '../../shared.ts'
import { tagEscape } from '../../../filters.ts'
import { parseFrontmatter } from '../../../frontmatter.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCtx } from '../../ctx.ts'

/** Cap to avoid reading 100s of files for a huge session. */
const SESSION_NOTE_CAP = 50

interface SessionNote {
  path: string
  title: string
  kind: string | null
  modified: string
  first_line: string
  link: string
}

interface SubgraphNode {
  path: string
  title: string
}

interface SubgraphEdge {
  source: string
  target: string
  resolved: boolean
}

/** Register memory_session_show: retrieve a thread-of-work by session tag. */
export function registerSession(server: McpServer, ctx: ToolCtx): void {
  const { db, vault, deepLink, json } = ctx

  server.registerTool(
    'memory_session_show',
    {
      title: 'Show a session thread',
      description:
        "Retrieve all notes tagged `session/<id>` — a thread-of-work (issue, debug arc, decision arc). " +
        'Returns notes mtime-ordered with a one-line arc digest and a wikilink subgraph of the thread. ' +
        'Use to recall everything written during a long-running issue or debug session.',
      inputSchema: {
        id: z.string().describe('session id (e.g. "ome-28", "debug-fnf-pdf") — matches the session/<id> tag'),
      },
      annotations: { readOnlyHint: true },
    },
    async a =>
      withUsage('memory_session_show', a, async () => {
        const tag = `session/${a.id}`
        const tagPrefix = tagEscape(tag) + '/%'

        const rows = db
          .prepare(
            `SELECT n.path, n.title, n.mtime, n.kind
             FROM notes n
             WHERE EXISTS (
               SELECT 1 FROM edges e
               WHERE e.src_path = n.path AND e.type = 'tag'
                 AND (e.dst = ? OR e.dst LIKE ? ESCAPE '\\')
             )
             ORDER BY n.mtime ASC
             LIMIT ?`,
          )
          .all(tag, tagPrefix, SESSION_NOTE_CAP) as { path: string; title: string; mtime: number; kind: string | null }[]

        if (!rows.length) {
          return json({ id: a.id, notes: [], arc_digest: 'No notes found for this session.', wikilink_subgraph: { nodes: [], edges: [] } })
        }

        // build note list with first_line from disk
        const notes: SessionNote[] = []
        const pathSet = new Set(rows.map(r => r.path))
        for (const r of rows) {
          let firstLine = ''
          try {
            const raw = readFileSync(join(vault, r.path), 'utf8')
            const { content } = parseFrontmatter(raw)
            firstLine = content.trim().split('\n').find(l => l.trim() && !l.startsWith('#'))?.slice(0, 120) ?? ''
          } catch {
            // file may have moved or been archived; skip
          }
          notes.push({
            path: r.path,
            title: r.title,
            kind: r.kind,
            modified: new Date(r.mtime).toISOString(),
            first_line: firstLine,
            link: deepLink(r.path),
          })
        }

        // arc digest: deterministic one-liner
        const firstDate = new Date(rows[0].mtime).toISOString().slice(0, 10)
        const lastDate = new Date(rows[rows.length - 1].mtime).toISOString().slice(0, 10)
        const kindCounts: Record<string, number> = {}
        for (const r of rows) {
          if (r.kind) kindCounts[r.kind] = (kindCounts[r.kind] ?? 0) + 1
        }
        const kindSummary = Object.entries(kindCounts)
          .map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`)
          .join(', ') || 'no kinds'
        const arcDigest = `${rows.length} notes from ${firstDate} to ${lastDate}: ${kindSummary}.`

        // wikilink subgraph: edges between notes in this session
        const pathPlaceholders = rows.map(() => '?').join(',')
        const edgeRows = db
          .prepare(
            `SELECT src_path, dst, resolved FROM edges
             WHERE type = 'wikilink'
               AND src_path IN (${pathPlaceholders})
               AND dst IN (${pathPlaceholders})`,
          )
          .all(...rows.map(r => r.path), ...rows.map(r => r.path)) as { src_path: string; dst: string; resolved: number }[]

        const subgraphNodes: SubgraphNode[] = rows.map(r => ({ path: r.path, title: r.title }))
        const subgraphEdges: SubgraphEdge[] = edgeRows.map(e => ({
          source: e.src_path,
          target: e.dst,
          resolved: e.resolved === 1,
        }))

        return json({
          id: a.id,
          notes,
          arc_digest: arcDigest,
          wikilink_subgraph: { nodes: subgraphNodes, edges: subgraphEdges },
        })
      }),
  )
}
