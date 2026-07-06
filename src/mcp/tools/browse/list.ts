import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { withUsage, kindSchema, folderPat } from '../../shared.ts'
import { tagEscape } from '../../../filters.ts'
import type { ToolCtx } from '../../ctx.ts'

/** Register memory_list: enumerate vault notes by folder and/or tag. */
export function registerList(server: McpServer, ctx: ToolCtx): void {
  const { db, json } = ctx

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
          params.push(a.tag, tagEscape(a.tag) + '/%')
        }
        const rows = db
          .prepare(
            `SELECT path, title, mtime FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY path LIMIT ?`,
          )
          .all(...params, a.limit ?? 100) as { path: string; title: string; mtime: number }[]
        return json(rows.map(r => ({ path: r.path, title: r.title, modified: new Date(r.mtime).toISOString() })))
      }),
  )
}
