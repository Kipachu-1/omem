import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { findUnused } from '../../../unused.ts'
import { withUsage } from '../../shared.ts'
import type { ToolCtx } from '../../ctx.ts'

/** Register memory_unused: find stale, unpinned, unreferenced notes (drift triage). */
export function registerUnused(server: McpServer, ctx: ToolCtx): void {
  const { db, deepLink, json } = ctx

  server.registerTool(
    'memory_unused',
    {
      title: 'Find stale or unreferenced notes',
      description:
        'Cheap one-call drift report. Returns notes that are: unpinned (frontmatter.pinned != true), ' +
        'not referenced by any wikilink edge (no inlink from another note), AND older than <mtime_days> ' +
        'days. Use to triage vault drift: which notes can be archived vs which still earn their keep. ' +
        'Read-only — no side effects.',
      inputSchema: {
        mtime_days: z
          .number()
          .int()
          .min(1)
          .default(30)
          .optional()
          .describe('Only include notes with mtime older than this many days. Default 30.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .optional()
          .describe('Max results. Default 50, hard cap 500.'),
        folder: z
          .string()
          .optional()
          .describe('Restrict to notes under this folder (e.g. "memory/"). Default: all.'),
      },
      annotations: { readOnlyHint: true },
    },
    async a =>
      withUsage('memory_unused', a, async () => {
        const res = findUnused(db, {
          mtimeDays: a.mtime_days ?? 30,
          limit: a.limit ?? 50,
          folder: a.folder,
        })
        return json({
          scanned: res.scanned,
          matched: res.matched,
          notes: res.notes.map(n => ({
            path: n.path,
            title: n.title,
            mtime: new Date(n.mtime).toISOString(),
            mtime_days: n.mtime_days,
            confidence: n.confidence,
            inlinks: n.inlinks,
            link: deepLink(n.path),
          })),
        })
      }),
  )
}
