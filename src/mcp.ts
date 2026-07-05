import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import matter from 'gray-matter'
import type { DB } from './db.ts'
import { indexFile, deleteNote, embedPending, SKIP_DIRS } from './indexer.ts'
import { search } from './search.ts'
import type { Embedder } from './embed.ts'

/** Build a fresh McpServer with all four memory tools registered (db/embedder are shared). */
export function buildServer(db: DB, vault: string, embedder: Embedder): McpServer {
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
        after: z.number().int().optional().describe('ms epoch; only notes with mtime >= this are eligible'),
        before: z.number().int().optional().describe('ms epoch; only notes with mtime <= this are eligible'),
      },
      annotations: { readOnlyHint: true },
    },
    async a => {
      const results = await search(db, a.query, {
        limit: a.limit,
        folder: a.folder,
        tags: a.tags,
        expandGraph: a.expandGraph,
        after: a.after,
        before: a.before,
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

  // folder LIKE-pattern with %/_/\ escaped, shared by list/recent-style filters
  const folderPat = (f: string) => f.replace(/\/+$/, '').replace(/[\\%_]/g, m => '\\' + m) + '/%'

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
      },
      annotations: { readOnlyHint: true },
    },
    async a => {
      const where: string[] = []
      const params: unknown[] = []
      if (a.folder) where.push("path LIKE ? ESCAPE '\\'"), params.push(folderPat(a.folder))
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
    },
  )

  server.registerTool(
    'memory_move',
    {
      title: 'Move / rename a note',
      description:
        'Move a note to a new vault-relative path — e.g. triage an inbox/ note into its island folder. ' +
        'Does NOT rewrite [[wikilinks]] pointing at the old name, so prefer moves that keep the filename.',
      inputSchema: {
        from: z.string().describe('current vault-relative path'),
        to: z.string().describe('new vault-relative path (folders are created as needed)'),
      },
    },
    async a => {
      const src = safeRel(a.from.endsWith('.md') ? a.from : a.from + '.md')
      if (!existsSync(src.abs)) throw new Error(`note not found: ${src.rel}`)
      let dst = safeRel(a.to.endsWith('.md') ? a.to : a.to + '.md')
      assertIndexable(dst.rel)
      if (existsSync(dst.abs)) throw new Error(`target already exists: ${dst.rel}`)
      mkdirSync(dirname(dst.abs), { recursive: true })
      dst = safeRel(dst.rel) // parent exists now: pick up its canonical casing
      renameSync(src.abs, dst.abs)
      deleteNote(db, src.rel)
      await indexNow(dst.rel)
      return json({ from: src.rel, to: dst.rel, link: deepLink(dst.rel) })
    },
  )

  server.registerTool(
    'memory_archive',
    {
      title: 'Archive a note',
      description:
        'Supersede a note: sets pinned:false, stamps archived_at, and moves it to archive/<original path>. ' +
        'This is the vault convention replacement for deletion — nothing is ever hard-deleted over MCP.',
      inputSchema: {
        path: z.string().describe('vault-relative path of the note to archive'),
        reason: z.string().optional().describe('why it was superseded; recorded as archived_reason'),
      },
    },
    async a => {
      const src = safeRel(a.path.endsWith('.md') ? a.path : a.path + '.md')
      if (!existsSync(src.abs)) throw new Error(`note not found: ${src.rel}`)
      if (src.rel.startsWith('archive/')) throw new Error(`already archived: ${src.rel}`)
      const raw = readFileSync(src.abs, 'utf8')
      let fm: Record<string, unknown> = {}
      let content = raw
      try {
        const parsed = matter(raw)
        if (parsed.data && typeof parsed.data === 'object') (fm = parsed.data as Record<string, unknown>), (content = parsed.content)
      } catch {
        // malformed frontmatter: archive the raw body under fresh frontmatter
      }
      fm = { ...fm, pinned: false, archived_at: new Date().toISOString(), ...(a.reason ? { archived_reason: a.reason } : {}) }
      let dst = safeRel(`archive/${src.rel}`)
      if (existsSync(dst.abs)) throw new Error(`archive target already exists: ${dst.rel}`)
      mkdirSync(dirname(dst.abs), { recursive: true })
      dst = safeRel(dst.rel)
      writeFileSync(dst.abs, matter.stringify(content, fm))
      unlinkSync(src.abs)
      deleteNote(db, src.rel)
      await indexNow(dst.rel)
      return json({ archived: src.rel, to: dst.rel, link: deepLink(dst.rel) })
    },
  )

  server.registerTool(
    'memory_sync',
    {
      title: 'Git-sync the vault now',
      description:
        'Force an immediate git commit + pull + push of the vault (same as `omem sync`). ' +
        'Use after important writes when the periodic sync is too slow; harmless if nothing changed.',
      inputSchema: {},
    },
    async () => {
      const { createGitSync } = await import('./git.ts')
      return json(await createGitSync(vault)({ pull: true }))
    },
  )

  return server
}

export async function serveMcp(db: DB, vault: string, embedder: Embedder): Promise<void> {
  await buildServer(db, vault, embedder).connect(new StdioServerTransport())
  console.error(`omem mcp server on stdio — vault: ${basename(realpathSync.native(resolve(vault)))}`)

  // the SDK transport doesn't watch for stdin EOF; without this, a crashed/closed
  // client leaves an orphaned serve process sweeping the vault db forever
  const shutdown = () => {
    console.error('mcp client disconnected — exiting')
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
}

/** constant-time bearer check; no token configured = open (opt-in auth) */
export function bearerOk(authHeader: string | undefined, token: string | undefined): boolean {
  if (!token) return true
  if (!authHeader?.startsWith('Bearer ')) return false
  const sha = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(sha(authHeader.slice(7)), sha(token))
}

/** MCP over streamable HTTP. Auth is optional: set OMEM_HTTP_TOKEN to require `Authorization: Bearer <token>`. */
export async function serveHttp(db: DB, vault: string, embedder: Embedder, port: number): Promise<void> {
  const { createServer } = await import('node:http')
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const token = process.env.OMEM_HTTP_TOKEN

  createServer(async (req, res) => {
    if (req.url?.split('?')[0] === '/healthz') return void res.end('ok')
    if (!bearerOk(req.headers.authorization, token)) {
      return void res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
    }
    // stateless mode: a fresh server+transport per request, no session bookkeeping to leak
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    try {
      await buildServer(db, vault, embedder).connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      console.error('mcp http error:', e)
      if (!res.headersSent) res.writeHead(500).end()
    }
  }).listen(port, () => {
    console.error(`omem mcp server on http://0.0.0.0:${port} — vault: ${basename(realpathSync.native(resolve(vault)))}`)
    if (!token) console.error('warning: OMEM_HTTP_TOKEN not set — the endpoint is UNAUTHENTICATED; anyone who can reach it can read/write the vault')
  })
}
