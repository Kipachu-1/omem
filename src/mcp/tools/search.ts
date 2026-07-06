import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { search, recall } from '../../search.ts'
import { withUsage, kindSchema } from '../shared.ts'
import type { ToolCtx } from '../ctx.ts'

/** Register memory_search + memory_recall (read/query cluster). */
export function registerSearchTools(server: McpServer, ctx: ToolCtx): void {
  const { db, embedder, deepLink, json } = ctx

  server.registerTool(
    'memory_search',
    {
      title: 'Search vault memory',
      description:
        'Hybrid search (semantic + keyword + wikilink-graph expansion) over the shared Obsidian memory vault. ' +
        'Use this FIRST when answering anything that may touch prior context: past decisions, conventions, projects, people, gotchas. ' +
        'Returns ranked chunks with note paths and obsidian:// links.',
      inputSchema: {
        query: z.string().describe('natural-language query'),
        limit: z.number().int().min(1).max(50).optional().describe('max results, default 10'),
        folder: z.string().optional().describe("restrict to a folder prefix, e.g. 'islands/y-agents'"),
        tags: z.array(z.string()).optional().describe('require all of these tags (nested tags match by prefix)'),
        expandGraph: z.boolean().optional().describe('include 1-hop wikilink neighbors of top hits, default true'),
        after: z.number().int().optional().describe('ms epoch; only notes with mtime >= this are eligible'),
        before: z.number().int().optional().describe('ms epoch; only notes with mtime <= this are eligible'),
        kinds: z.array(kindSchema).optional().describe('restrict to these memory kinds (decision|gotcha|convention|fact|meeting|log)'),
        pinned: z.boolean().optional().describe('only pinned notes'),
      },
      annotations: { readOnlyHint: true },
    },
    async a =>
      withUsage('memory_search', a, async () => {
        const results = await search(db, a.query, {
          limit: a.limit,
          folder: a.folder,
          tags: a.tags,
          expandGraph: a.expandGraph,
          after: a.after,
          before: a.before,
          kinds: a.kinds,
          pinned: a.pinned,
          embedder,
        })
        return json(results.map(r => ({ ...r, link: deepLink(r.notePath) })))
      }),
  )

  server.registerTool(
    'memory_recall',
    {
      title: 'Recall relevant context for a task',
      description:
        'One-call context retrieval for a task, question, or topic. Returns ranked results ' +
        'grouped by kind (decision / gotcha / convention / fact / meeting / log), with ' +
        'pinned items and load-bearing kinds (decision, gotcha, convention) boosted to the top. ' +
        'Use this before acting on anything that may have prior context, instead of guessing ' +
        'a query for memory_search.',
      inputSchema: {
        context: z.string().describe('the task, question, or topic to recall for (natural language)'),
        limit: z.number().int().min(1).max(50).optional().describe('total results, default 20'),
        kinds: z
          .array(kindSchema)
          .optional()
          .describe('restrict to these kinds; default = all'),
        pinnedOnly: z.boolean().optional().describe('only return pinned notes (highest-signal quick mode)'),
        folder: z.string().optional().describe('restrict to a folder prefix'),
      },
      annotations: { readOnlyHint: true },
    },
    async a =>
      withUsage('memory_recall', a, async () => {
        if (!a.context.trim()) throw new Error('context required')
        const r = await recall(db, a.context, {
          limit: a.limit,
          kinds: a.kinds,
          pinnedOnly: a.pinnedOnly,
          folder: a.folder,
          embedder,
        })
        const withLinks = (arr: { notePath: string }[]) =>
          arr.map(x => ({ ...x, link: deepLink(x.notePath) }))
        return json({
          query: r.query,
          grouped: Object.fromEntries(Object.entries(r.grouped).map(([k, v]) => [k, withLinks(v)])),
          related: withLinks(r.related),
          totalScanned: r.totalScanned,
        })
      }),
  )
}
