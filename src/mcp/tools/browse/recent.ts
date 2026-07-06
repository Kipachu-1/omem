import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClientSeen, setClientSeen } from '../../../db.ts'
import { withUsage, SINCE_MS, folderPat } from '../../shared.ts'
import type { ToolCtx } from '../../ctx.ts'

/** Register memory_recent: recently modified notes (with per-client watermark support). */
export function registerRecent(server: McpServer, ctx: ToolCtx): void {
  const { db, deepLink, json, getClientName } = ctx

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
}
