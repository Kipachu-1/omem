import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { parseFrontmatter, stringifyFrontmatter } from '../../frontmatter.ts'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { deleteNote } from '../../indexer.ts'
import { commitNotes, noteHash, retargetHistory, type NoteChange } from '../../note-write.ts'
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
  mode?: 'create' | 'overwrite' | 'append' | 'update'
  expectedHash?: string
  frontmatter?: Record<string, unknown>
  kind?: string
  skipDedup?: boolean
  supersedes?: string[]
}

export interface WriteResult {
  path: string
  mode: string
  link: string
  hash: string
  similarExisting?: { path: string; title: string; heading: string | null; score: number }[]
  superseded?: { archived: string; to: string; reason?: string }[]
}

/**
 * Filename-safe slug: lowercase, non-alphanumeric runs collapsed to `-`, capped at 60.
 * Drops `/`, `.` and every other separator, so a slug can never widen a path.
 * Shared by the note-filename builder and `memory_learn`'s island name.
 * Trim runs AFTER the cap — slicing mid-run would otherwise re-introduce a trailing `-`.
 */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '') || 'note'
  )
}

/**
 * Core write logic shared by the `memory_write` MCP tool and the REPL `/write`.
 * Creates memory/YYYY-MM-DD-<slug>.md by default; overwrite/append target an
 * existing `path`; update preserves omitted metadata. Returns the written path, dedup candidates, and any archived
 * predecessors. Pure of any MCP/CLI concerns — callers format the result.
 */
export async function writeNote(ctx: ToolCtx, a: WriteArgs): Promise<WriteResult> {
  const { db, embedder, deepLink, safeRel, assertIndexable, indexNow } = ctx
  const mode = a.mode ?? 'create'
  let rel: string
  let abs: string

  if (mode === 'create') {
    const folder = (a.folder ?? 'memory').replace(/\/+$/, '')
    const slug = slugify(a.title)
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

  if (a.expectedHash && mode === 'create') throw new Error('expectedHash requires an existing note')
  const confidence = a.frontmatter?.confidence
  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1))
    throw new Error('confidence must be a finite number between 0 and 1')

  let superseded: WriteResult['superseded']
  let writtenRaw = ''
  commitNotes(db, ctx.vault, () => {
    // Recheck after acquiring the shared index lock, before changing any files.
    if (mode === 'create' && existsSync(abs)) throw new Error(`target already exists: ${rel}; retry create`)
    const raw = mode === 'create' ? '' : readFileSync(abs, 'utf8')
    if (a.expectedHash && noteHash(raw) !== a.expectedHash) throw new Error(`note changed: ${rel}; read it again before updating`)
    const previous = parseFrontmatter(raw).frontmatter
    const oldNotes: { src: { rel: string; abs: string }; dst: { rel: string; abs: string }; raw: string }[] = []
    const seen = new Set<string>()
    if (mode === 'create') for (const old of a.supersedes ?? []) {
      const src = safeRel(old.endsWith('.md') ? old : old + '.md')
      assertIndexable(src.rel)
      if (src.rel.startsWith('archive/')) throw new Error(`already archived: ${src.rel}`)
      if (!existsSync(src.abs)) throw new Error(`supersedes target not found: ${src.rel}`)
      if (seen.has(src.rel)) throw new Error(`duplicate supersedes target: ${src.rel}`)
      seen.add(src.rel)
      const dst = safeRel(`archive/${src.rel}`)
      assertIndexable(dst.rel)
      if (existsSync(dst.abs)) throw new Error(`archive target already exists: ${dst.rel}`)
      // Resolve newly created parents again to enforce vault boundaries and canonical casing.
      mkdirSync(dirname(dst.abs), { recursive: true })
      const canonicalDst = safeRel(dst.rel)
      oldNotes.push({ src, dst: canonicalDst, raw: readFileSync(src.abs, 'utf8') })
    }
    const now = new Date().toISOString()
    if (mode === 'append') writtenRaw = raw + `\n\n${a.content.trim()}\n`
    else {
      const fm: Record<string, unknown> = {
        ...(mode === 'update' ? previous : {}),
        ...(a.frontmatter ?? {}),
        title: a.title,
        created: mode === 'update' ? previous.created ?? now : now,
        source: mode === 'update' ? previous.source ?? 'agent' : 'agent',
        ...(mode === 'update' ? { updated: now } : {}),
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.tags !== undefined ? { tags: a.tags } : {}),
        ...(oldNotes.length ? { supersedes: oldNotes.map(n => n.dst.rel) } : {}),
      }
      const related = a.links?.length ? `\n\n## Related\n${a.links.map(l => `- [[${l}]]`).join('\n')}\n` : ''
      writtenRaw = stringifyFrontmatter(`\n${a.content.trim()}${related}`, fm)
    }
    // Publish the successor before removing predecessors. Roll back completed mutations on error.
    const changes: NoteChange[] = [{ rel, abs, raw: writtenRaw }]
    if (oldNotes.length) superseded = []
    for (const old of oldNotes) {
      const parsed = parseFrontmatter(old.raw)
      const reason = `superseded by ${rel}`
      changes.push({ ...old.dst, raw: stringifyFrontmatter(parsed.content, {
        ...parsed.frontmatter, pinned: false, archived_at: now, archived_reason: reason, superseded_by: rel,
      }) }, { ...old.src, raw: null })
      superseded!.push({ archived: old.src.rel, to: old.dst.rel, reason })
    }
    changes.push(...retargetHistory(db, safeRel, new Map(oldNotes.map(n => [n.src.rel, n.dst.rel]))))
    return changes
  })

  await indexNow(rel)

  // post-write similarity check: embed the body, rank existing chunks, return near-dups.
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

  const out: WriteResult = { path: rel, mode, link: deepLink(rel), hash: noteHash(writtenRaw) }
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
        'To update an existing note pass its path with mode "update" (replace body and merge metadata), "overwrite" (replace everything), or "append". ' +
        'Use expectedHash from memory_get_note to reject stale edits. ' +
        'Link related notes via `links` — they become [[wikilinks]] and graph edges. ' +
        'Extra frontmatter fields (island, pinned, confidence, ...) can be set via `frontmatter`. ' +
        'On create, a post-write similarity check returns up to 5 near-duplicate existing notes under `similarExisting` ' +
        '(score >= 0.78) so the caller can supersede them instead of writing a dup. Pass `skipDedup: true` to bypass ' +
        'this check (faster, useful for bulk imports). Pass `supersedes` to archive a list of old note paths as ' +
        'superseded by the new note in the same call.',
      inputSchema: {
        title: z.string(),
        content: z.string().describe('markdown body of the memory'),
        tags: z.array(z.string()).optional(),
        links: z.array(z.string()).optional().describe("related note names/titles, e.g. ['Canvas Renderer']"),
        folder: z.string().optional().describe("target folder for new notes, default 'memory'"),
        path: z.string().optional().describe('existing note path, required for update/overwrite/append'),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('SHA-256 returned by memory_get_note; rejects stale edits'),
        mode: z.enum(['create', 'overwrite', 'append', 'update']).optional().describe('default create'),
        frontmatter: z.record(z.unknown()).optional().describe('extra frontmatter fields merged into the note'),
        kind: kindSchema.optional().describe('memory class: decision|gotcha|convention|fact|meeting|log'),
        skipDedup: z
          .boolean()
          .optional()
          .describe('set to true to bypass the post-write similarity check (faster, useful for bulk imports)'),
        supersedes: z
          .array(z.string())
          .optional()
          .describe('vault-relative paths to archive as superseded by the new note; records predecessor and successor paths'),
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

