import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { noteGraph } from '../../../graph.ts'
import { withUsage } from '../../shared.ts'
import type { ToolCtx } from '../../ctx.ts'

/** Register memory_graph: browse the note neighborhood (k-hop wikilinks, tags, embeddings). */
export function registerGraph(server: McpServer, ctx: ToolCtx): void {
  const { db, embedder, deepLink, safeRel, json } = ctx

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
        const result = await noteGraph(db, embedder, rel, deepLink, {
          outgoing: a.outgoing,
          incoming: a.incoming,
          byTag: a.byTag,
          byEmbedding: a.byEmbedding,
          k: a.k,
          limit: a.limit,
        })
        return json(result)
      }),
  )
}
