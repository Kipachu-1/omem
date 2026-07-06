import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { parseFrontmatter } from '../../../frontmatter.ts'
import { withUsage } from '../../shared.ts'
import type { ToolCtx } from '../../ctx.ts'

/** Register memory_get_note: read a full note (content, frontmatter, backlinks). */
export function registerGetNote(server: McpServer, ctx: ToolCtx): void {
  const { db, deepLink, safeRel, json } = ctx

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
        const { frontmatter, content } = parseFrontmatter(raw)
        const backlinks = (
          db
            .prepare("SELECT DISTINCT src_path FROM edges WHERE dst = ? AND type = 'wikilink' AND resolved = 1")
            .all(rel) as { src_path: string }[]
        ).map(r => r.src_path)
        return json({ path: rel, frontmatter, content, backlinks, link: deepLink(rel) })
      }),
  )
}
