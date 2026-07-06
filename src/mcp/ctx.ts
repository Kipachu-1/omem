import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync, renameSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import type { DB } from '../db.ts'
import { indexFile, deleteNote, embedPending, SKIP_DIRS } from '../indexer.ts'
import type { Embedder } from '../embed.ts'

export interface ToolCtx {
  db: DB
  vault: string
  embedder: Embedder
  vaultAbs: string
  vaultName: string
  getClientName: () => string
  deepLink: (p: string) => string
  safeRel: (p: string) => { rel: string; abs: string }
  assertIndexable: (rel: string) => void
  json: (v: unknown) => { content: { type: 'text'; text: string }[] }
  indexNow: (rel: string) => Promise<void>
  archiveNote: (relPath: string, reason?: string) => Promise<{ archived: string; to: string; link: string }>
}

/** Build closure-dependent helpers shared across all tool registrations. */
export function buildToolCtx(
  db: DB,
  vault: string,
  embedder: Embedder,
  getClientName: () => string,
): ToolCtx {
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

  // shared archive logic used by memory_archive AND memory_write's `supersedes` path.
  // Sets pinned:false, stamps archived_at + reason, moves the note to archive/<orig>,
  // re-indexes. Returns the new archive path + deep link.
  const archiveNote = async (
    relPath: string,
    reason?: string,
  ): Promise<{ archived: string; to: string; link: string }> => {
    const src = safeRel(relPath.endsWith('.md') ? relPath : relPath + '.md')
    if (!existsSync(src.abs)) throw new Error(`note not found: ${src.rel}`)
    if (src.rel.startsWith('archive/')) throw new Error(`already archived: ${src.rel}`)
    const raw = readFileSync(src.abs, 'utf8')
    let fm: Record<string, unknown> = {}
    let content = raw
    try {
      const parsed = matter(raw)
      if (parsed.data && typeof parsed.data === 'object')
        (fm = parsed.data as Record<string, unknown>), (content = parsed.content)
    } catch {
      // malformed frontmatter: archive the raw body under fresh frontmatter
    }
    fm = {
      ...fm,
      pinned: false,
      archived_at: new Date().toISOString(),
      ...(reason ? { archived_reason: reason } : {}),
    }
    let dst = safeRel(`archive/${src.rel}`)
    if (existsSync(dst.abs)) throw new Error(`archive target already exists: ${dst.rel}`)
    mkdirSync(dirname(dst.abs), { recursive: true })
    dst = safeRel(dst.rel)
    writeFileSync(dst.abs, matter.stringify(content, fm))
    unlinkSync(src.abs)
    deleteNote(db, src.rel)
    await indexNow(dst.rel)
    return { archived: src.rel, to: dst.rel, link: deepLink(dst.rel) }
  }

  return { db, vault, embedder, vaultAbs, vaultName, getClientName, deepLink, safeRel, assertIndexable, json, indexNow, archiveNote }
}
