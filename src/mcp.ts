import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import matter from 'gray-matter'
import type { DB } from './db.ts'
import { indexFile, embedPending, SKIP_DIRS } from './indexer.ts'
import { search } from './search.ts'
import type { Embedder } from './embed.ts'

export async function serveMcp(db: DB, vault: string, embedder: Embedder): Promise<void> {
  const vaultAbs = realpathSync.native(resolve(vault))
  const vaultName = basename(vaultAbs)
  const deepLink = (p: string) =>
    `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(p.replace(/\.md$/, ''))}`

  // canonicalize (./, //, .., symlinks, APFS case) so index keys always match what walkVault produces
  const canon = (a: string): string => {
    try {
      return realpathSync.native(a)
    } catch {
      try {
        return join(realpathSync.native(dirname(a)), basename(a)) // leaf not on disk yet: canonicalize the parent
      } catch {
        return a
      }
    }
  }

  const safeRel = (p: string): { rel: string; abs: string } => {
    const abs = canon(resolve(vaultAbs, p.replace(/^\/+/, '')))
    const rel = relative(vaultAbs, abs).split(sep).join('/')
    if (abs !== vaultAbs && (!abs.startsWith(vaultAbs + sep) || rel.startsWith('..')))
      throw new Error(`path escapes the vault: ${p}`)
    return { rel, abs }
  }

  // the watcher and full-sync sweep skip hidden/system folders; writing there would
  // create notes that get silently un-indexed by the next sweep (or clobber .omem/.obsidian)
  const assertIndexable = (rel: string): void => {
    const parts = rel.split('/')
    if (!rel.toLowerCase().endsWith('.md') || parts.some(s => s.startsWith('.') || SKIP_DIRS.has(s)))
      throw new Error(`path is not indexable (hidden or system folder): ${rel}`)
  }

  const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] })

  // index synchronously after a write so the note is searchable before the tool returns
  const indexNow = async (rel: string): Promise<void> => {
    indexFile(db, vault, rel)
    try {
      await embedPending(db, embedder)
    } catch {
      // keyword search works immediately; embeddings self-heal on the next pass
    }
  }

  const server = new McpServer({ name: 'omem', version: '0.1.0' })

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
      },
      annotations: { readOnlyHint: true },
    },
    async a => {
      const results = await search(db, a.query, {
        limit: a.limit,
        folder: a.folder,
        tags: a.tags,
        expandGraph: a.expandGraph,
        embedder,
      })
      return json(results.map(r => ({ ...r, link: deepLink(r.notePath) })))
    },
  )

  server.registerTool(
    'memory_get_note',
    {
      title: 'Read a full note',
      description: 'Full content, frontmatter, and backlinks of one vault note by path (as returned by memory_search).',
      inputSchema: { path: z.string().describe("vault-relative path, e.g. 'islands/y-agents/README.md'") },
      annotations: { readOnlyHint: true },
    },
    async a => {
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
    },
  )

  server.registerTool(
    'memory_write',
    {
      title: 'Write a memory note',
      description:
        'Persist a memory as a markdown note in the vault. Default: creates memory/YYYY-MM-DD-<slug>.md. ' +
        'To update an existing note pass its path with mode "overwrite" (replace) or "append" (add to the end). ' +
        'Link related notes via `links` — they become [[wikilinks]] and graph edges. ' +
        'Extra frontmatter fields (island, pinned, confidence, ...) can be set via `frontmatter`.',
      inputSchema: {
        title: z.string(),
        content: z.string().describe('markdown body of the memory'),
        tags: z.array(z.string()).optional(),
        links: z.array(z.string()).optional().describe("related note names/titles, e.g. ['Canvas Renderer']"),
        folder: z.string().optional().describe("target folder for new notes, default 'memory'"),
        path: z.string().optional().describe('existing note path, required for overwrite/append'),
        mode: z.enum(['create', 'overwrite', 'append']).optional().describe('default create'),
        frontmatter: z.record(z.unknown()).optional().describe('extra frontmatter fields merged into the note'),
      },
    },
    async a => {
      const mode = a.mode ?? 'create'
      let rel: string
      let abs: string

      if (mode === 'create') {
        const folder = (a.folder ?? 'memory').replace(/\/+$/, '')
        const slug =
          a.title
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'note'
        const date = new Date().toISOString().slice(0, 10)
        let candidate = `${folder}/${date}-${slug}.md`
        for (let n = 2; existsSync(safeRel(candidate).abs); n++) candidate = `${folder}/${date}-${slug}-${n}.md`
        ;({ rel, abs } = safeRel(candidate))
        assertIndexable(rel)
        mkdirSync(resolve(abs, '..'), { recursive: true })
        ;({ rel, abs } = safeRel(candidate)) // parent exists now: pick up its canonical casing
      } else {
        if (!a.path) throw new Error(`mode "${mode}" requires path`)
        ;({ rel, abs } = safeRel(a.path.endsWith('.md') ? a.path : a.path + '.md'))
        assertIndexable(rel)
        if (!existsSync(abs)) throw new Error(`note not found: ${rel}`)
      }

      if (mode === 'append') {
        appendFileSync(abs, `\n\n${a.content.trim()}\n`)
      } else {
        // provenance fields last: untrusted frontmatter must not spoof source/created/title
        const fm: Record<string, unknown> = {
          ...(a.frontmatter ?? {}),
          title: a.title,
          created: new Date().toISOString(),
          source: 'agent',
          ...(a.tags?.length ? { tags: a.tags } : {}),
        }
        const related = a.links?.length ? `\n\n## Related\n${a.links.map(l => `- [[${l}]]`).join('\n')}\n` : ''
        writeFileSync(abs, matter.stringify(`\n${a.content.trim()}${related}`, fm))
      }

      await indexNow(rel)
      return json({ path: rel, mode, link: deepLink(rel) })
    },
  )

  server.registerTool(
    'memory_recent',
    {
      title: 'Recently modified notes',
      description: "Most recently modified vault notes — 'what have we been working on'.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('default 10'),
        folder: z.string().optional().describe('restrict to a folder prefix'),
      },
      annotations: { readOnlyHint: true },
    },
    async a => {
      const where = a.folder ? "WHERE path LIKE ? ESCAPE '\\'" : ''
      const params = a.folder ? [a.folder.replace(/\/+$/, '').replace(/[\\%_]/g, m => '\\' + m) + '/%'] : []
      const rows = db
        .prepare(`SELECT path, title, mtime FROM notes ${where} ORDER BY mtime DESC LIMIT ?`)
        .all(...params, a.limit ?? 10) as { path: string; title: string; mtime: number }[]
      return json(rows.map(r => ({ ...r, modified: new Date(r.mtime).toISOString(), link: deepLink(r.path) })))
    },
  )

  await server.connect(new StdioServerTransport())
  console.error(`omem mcp server on stdio — vault: ${vaultName}`)

  // the SDK transport doesn't watch for stdin EOF; without this, a crashed/closed
  // client leaves an orphaned serve process sweeping the vault db forever
  const shutdown = () => {
    console.error('mcp client disconnected — exiting')
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
}
