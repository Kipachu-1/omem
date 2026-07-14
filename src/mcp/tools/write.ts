import { z } from 'zod'
import { existsSync, mkdirSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { stringifyFrontmatter } from '../../frontmatter.ts'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { deleteNote } from '../../indexer.ts'
import { topSimilar } from '../../search.ts'
import { withUsage, kindSchema, DEDUP_THRESHOLD } from '../shared.ts'
import type { ToolCtx } from '../ctx.ts'

export interface WriteArgs {
  title: string
  content: string
  tags?: string[]
  links?: string[]
  folder?: string
  path?: string
  mode?: 'create' | 'overwrite' | 'append'
  frontmatter?: Record<string, unknown>
  kind?: string
  skipDedup?: boolean
  supersedes?: string[]
}

export interface WriteResult {
  path: string
  mode: string
  link: string
  similarExisting?: { path: string; title: string; heading: string | null; score: number }[]
  superseded?: { archived: string; to: string; reason?: string }[]
}

/**
 * Core write logic shared by the `memory_write` MCP tool and the REPL `/write`.
 * Creates memory/YYYY-MM-DD-<slug>.md by default; overwrite/append target an
 * existing `path`. Returns the written path, dedup candidates, and any archived
 * predecessors. Pure of any MCP/CLI concerns — callers format the result.
 */
export async function writeNote(ctx: ToolCtx, a: WriteArgs): Promise<WriteResult> {
  const { db, embedder, deepLink, safeRel, assertIndexable, indexNow, archiveNote } = ctx
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

  // `supersedes`: archive each old note as superseded by the new path BEFORE writing.
  // Only valid on create (the new note is the successor); silently ignored on overwrite/append.
  // Pre-validate ALL paths first so a mid-loop failure can't leave some notes archived
  // but the new note never written (phantom successor reference).
  let superseded: { archived: string; to: string; reason?: string }[] | undefined
  if (mode === 'create' && a.supersedes?.length) {
    for (const old of a.supersedes) {
      const chk = safeRel(old.endsWith('.md') ? old : old + '.md')
      if (!existsSync(chk.abs)) throw new Error(`supersedes target not found: ${chk.rel}`)
    }
    superseded = []
    for (const old of a.supersedes) {
      const r = await archiveNote(old, `superseded by ${rel}`)
      superseded.push({ archived: r.archived, to: r.to, reason: `superseded by ${rel}` })
    }
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
      ...(a.kind ? { kind: a.kind } : {}),
      ...(a.tags?.length ? { tags: a.tags } : {}),
    }
    const related = a.links?.length ? `\n\n## Related\n${a.links.map(l => `- [[${l}]]`).join('\n')}\n` : ''
    writeFileSync(abs, stringifyFrontmatter(`\n${a.content.trim()}${related}`, fm))
  }

  await indexNow(rel)

  // pre-write similarity check: embed the body, rank existing chunks, return near-dups.
  // Non-blocking: failures degrade to an empty list, never break the write.
  let similarExisting: WriteResult['similarExisting'] = []
  if (mode === 'create' && !a.skipDedup && a.content.trim().length >= 40) {
    try {
      const hits = await topSimilar(db, embedder, a.content, 5)
      similarExisting = hits
        .filter(h => h.note_path !== rel && h.score >= DEDUP_THRESHOLD)
        .map(h => ({ path: h.note_path, title: h.title, heading: h.heading, score: h.score }))
    } catch {
      // embedder unavailable or model mismatch: skip silently
    }
  }

  const out: WriteResult = { path: rel, mode, link: deepLink(rel) }
  if (similarExisting.length) out.similarExisting = similarExisting
  if (superseded) out.superseded = superseded
  return out
}

/** Register mutate tools: memory_write, memory_move, memory_archive. */
export function registerWriteTools(server: McpServer, ctx: ToolCtx): void {
  const { db, deepLink, safeRel, assertIndexable, json, indexNow, archiveNote } = ctx

  server.registerTool(
    'memory_write',
    {
      title: 'Write a memory note',
      description:
        'Persist a memory as a markdown note in the vault. Default: creates memory/YYYY-MM-DD-<slug>.md. ' +
        'To update an existing note pass its path with mode "overwrite" (replace) or "append" (add to the end). ' +
        'Link related notes via `links` — they become [[wikilinks]] and graph edges. ' +
        'Extra frontmatter fields (island, pinned, confidence, ...) can be set via `frontmatter`. ' +
        'On create, a pre-write similarity check returns up to 5 near-duplicate existing notes under `similarExisting` ' +
        '(score >= 0.78) so the caller can supersede them instead of writing a dup. Pass `skipDedup: true` to bypass ' +
        'this check (faster, useful for bulk imports). Pass `supersedes` to archive a list of old note paths as ' +
        'superseded by the new note in the same call.',
      inputSchema: {
        title: z.string(),
        content: z.string().describe('markdown body of the memory'),
        tags: z.array(z.string()).optional(),
        links: z.array(z.string()).optional().describe("related note names/titles, e.g. ['Canvas Renderer']"),
        folder: z.string().optional().describe("target folder for new notes, default 'memory'"),
        path: z.string().optional().describe('existing note path, required for overwrite/append'),
        mode: z.enum(['create', 'overwrite', 'append']).optional().describe('default create'),
        frontmatter: z.record(z.unknown()).optional().describe('extra frontmatter fields merged into the note'),
        kind: kindSchema.optional().describe('memory class: decision|gotcha|convention|fact|meeting|log'),
        skipDedup: z
          .boolean()
          .optional()
          .describe('set to true to bypass the pre-write similarity check (faster, useful for bulk imports)'),
        supersedes: z
          .array(z.string())
          .optional()
          .describe('vault-relative paths to archive as superseded by the new note before writing it'),
      },
    },
    async a => withUsage('memory_write', a, async () => json(await writeNote(ctx, a))),
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
    async a =>
      withUsage('memory_move', a, async () => {
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
      }),
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
    async a =>
      withUsage('memory_archive', a, async () => {
        return json(await archiveNote(a.path, a.reason))
      }),
  )
}

