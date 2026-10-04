import { durable } from './durable.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { DB } from '../db.ts'
import { createBundle, readBundle, skillFileSchema, skillNameSchema, skillPathSchema, skillSummarySchema, writeBundle } from './bundle.ts'
import type { SkillBundle, SkillDetails, SkillFile, SkillSummary } from './bundle.ts'

const revisionSchema = skillSummarySchema.shape.revision
export const skillListArgsSchema = z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(1000).default(50), offset: z.number().int().nonnegative().default(0) })
export const skillReadFileArgsSchema = z.object({ name: skillNameSchema, path: skillPathSchema, expectedRevision: revisionSchema })
export const skillWriteArgsSchema = z.object({ name: skillNameSchema, files: z.array(skillFileSchema), removeFiles: z.array(skillPathSchema).default([]), expectedRevision: revisionSchema.nullable() })
export const skillArchiveArgsSchema = z.object({ name: skillNameSchema, expectedRevision: revisionSchema })
export type SkillListArgs = z.input<typeof skillListArgsSchema>
export type SkillReadFileArgs = z.input<typeof skillReadFileArgsSchema>
export type SkillWriteArgs = z.input<typeof skillWriteArgsSchema>
export type SkillArchiveArgs = z.input<typeof skillArchiveArgsSchema>
export interface SkillStore {
  list(args?: SkillListArgs): { skills: SkillSummary[]; total: number; diagnostics: { name: string; error: string }[] }
  get(name: string): SkillDetails
  readFile(args: SkillReadFileArgs): SkillFile
  write(args: SkillWriteArgs): SkillDetails
  archive(args: SkillArchiveArgs): { name: string; revision: string; archived: string }
}

const journalSchema = z.object({
  id: z.string().uuid(), name: skillNameSchema,
  beforeRevision: revisionSchema.nullable(), afterRevision: revisionSchema,
  publication: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('write') }),
    z.object({ kind: z.literal('archive'), basename: z.string().regex(/^[a-z0-9-]+-[a-f0-9]{64}(?:-[a-f0-9-]{36})?$/) }),
  ]),
})
type Journal = z.infer<typeof journalSchema>

function details(bundle: SkillBundle): SkillDetails {
  const { files: _files, ...result } = bundle
  return result
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function durableTree(directory: string): void {
  for (const child of readdirSync(directory)) {
    const path = resolve(directory, child)
    if (lstatSync(path).isDirectory()) durableTree(path)
    else durable(path)
  }
  durable(directory)
}

export function createSkillStore(db: DB, vault: string): SkillStore {
  const root = realpathSync(vault)
  // All publication parents are real directories. No parent or skill root may be a symlink.
  function safe(path: string, make = false): string {
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== path) throw new Error('Skill path escapes vault')
    let current = root
    for (const part of rel.split(sep).filter(Boolean)) {
      current = resolve(current, part)
      if (!existsSync(current)) {
        // lstat catches dangling links that existsSync does not see.
        try { lstatSync(current); throw new Error(`Symlink or invalid skill path: ${current}`) }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
        if (make) { mkdirSync(current); durable(current); durable(dirname(current)) }
        else continue
      }
      if (existsSync(current)) {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Skill path must be a real directory: ${current}`)
      }
    }
    return path
  }
  const skillsPath = resolve(root, 'skills')
  const archivesPath = resolve(root, 'archive/skills')
  const transactionsPath = resolve(root, '.omem/skill-transactions')
  const activePath = (name: string) => safe(resolve(skillsPath, name))
  function paths(journal: Journal) {
    if (journal.publication.kind === 'archive' && journal.publication.basename !== `${journal.name}-${journal.afterRevision}` && !journal.publication.basename.startsWith(`${journal.name}-${journal.afterRevision}-`)) throw new Error('Skill archive journal target mismatch')
    const transaction = safe(resolve(transactionsPath, journal.id))
    return {
      transaction, stage: safe(resolve(transaction, 'stage')), backup: safe(resolve(transaction, 'backup')),
      active: activePath(journal.name),
      target: journal.publication.kind === 'write' ? activePath(journal.name) : safe(resolve(archivesPath, journal.publication.basename)),
    }
  }
  function matches(path: string, name: string, revision: string): boolean {
    try { return readBundle(path, name).revision === revision } catch { return false }
  }
  function cleanup(journal: Journal): void {
    const p = paths(journal)
    rmSync(p.transaction, { recursive: true, force: true })
    durable(transactionsPath)
    db.prepare('DELETE FROM meta WHERE key = ?').run(`skill.transaction.${journal.id}`)
  }
  function recoverOne(journal: Journal): void {
    const p = paths(journal)
    const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get(`skill.transaction.${journal.id}`)
    if (marker !== undefined) {
      if (z.object({ value: revisionSchema }).parse(marker).value !== journal.afterRevision) throw new Error(`Skill recovery conflict for ${journal.name}: commit marker mismatch`)
      if (!matches(p.target, journal.name, journal.afterRevision) || (journal.publication.kind === 'archive' && existsSync(p.active))) throw new Error(`Skill recovery conflict for ${journal.name}: published files changed; preserved transaction ${journal.id}`)
      if (existsSync(p.backup) && (journal.beforeRevision === null || !matches(p.backup, journal.name, journal.beforeRevision))) throw new Error(`Skill recovery conflict for ${journal.name}: backup changed`)
      cleanup(journal)
      return
    }
    const hasBackup = existsSync(p.backup)
    if (hasBackup && (journal.beforeRevision === null || !matches(p.backup, journal.name, journal.beforeRevision))) throw new Error(`Skill recovery conflict for ${journal.name}: backup changed`)
    if (existsSync(p.target) && !existsSync(p.stage)) {
      const previousUnmoved = !hasBackup && journal.publication.kind === 'write' && journal.beforeRevision !== null && matches(p.target, journal.name, journal.beforeRevision)
      if (!previousUnmoved) {
        if (!matches(p.target, journal.name, journal.afterRevision)) throw new Error(`Skill recovery conflict for ${journal.name}: external edits preserved`)
        if (hasBackup && journal.publication.kind === 'archive' && existsSync(p.active)) throw new Error(`Skill recovery conflict for ${journal.name}: active skill changed`)
        rmSync(p.target, { recursive: true })
        durable(dirname(p.target))
      }
    }
    if (hasBackup) {
      if (existsSync(p.active)) throw new Error(`Skill recovery conflict for ${journal.name}: active skill changed`)
      renameSync(p.backup, p.active)
      durable(skillsPath)
      durable(p.transaction)
    }
    cleanup(journal)
  }
  function recover(): void {
    safe(skillsPath, true); safe(archivesPath, true); safe(transactionsPath, true)
    for (const id of readdirSync(transactionsPath).sort()) {
      if (!z.string().uuid().safeParse(id).success) throw new Error(`Unrecognized skill transaction directory: ${id}`)
      const transaction = safe(resolve(transactionsPath, id))
      const journalPath = resolve(transaction, 'journal.json')
      if (!existsSync(journalPath)) {
        // A crash while staging occurs before publication and leaves no visible swap.
        rmSync(transaction, { recursive: true }); durable(transactionsPath); continue
      }
      if (lstatSync(journalPath).isSymbolicLink()) throw new Error('Skill transaction journal cannot be a symlink')
      const journal = journalSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8')))
      if (journal.id !== id) throw new Error('Skill transaction journal identity mismatch')
      recoverOne(journal)
    }
  }
  function locked<T>(operation: () => T): T {
    return db.transaction(() => { recover(); return operation() }).immediate()
  }
  function current(name: string): SkillBundle {
    const path = activePath(skillNameSchema.parse(name))
    if (!existsSync(path)) throw new Error(`Skill not found: ${name}`)
    return readBundle(path, name)
  }
  function checkRevision(bundle: SkillBundle | undefined, expected: string | null): void {
    if ((bundle?.revision ?? null) !== expected) throw new Error('Skill revision conflict: re-read the skill before writing')
  }
  function publish(bundle: SkillBundle, beforeRevision: string | null, publication: Journal['publication']): void {
    const journal: Journal = { id: randomUUID(), name: bundle.name, beforeRevision, afterRevision: bundle.revision, publication }
    const transaction = safe(resolve(transactionsPath, journal.id), true)
    const p = paths(journal)
    try {
      writeBundle(p.stage, bundle.files)
      durableTree(p.stage)
      writeFileSync(resolve(transaction, 'journal.json'), JSON.stringify(journal), { flag: 'wx' })
      durable(resolve(transaction, 'journal.json')); durable(transaction); durable(transactionsPath)
      if (beforeRevision !== null) {
        if (!matches(p.active, bundle.name, beforeRevision)) throw new Error('Skill changed during staging')
        renameSync(p.active, p.backup)
        durable(skillsPath); durable(transaction)
      } else if (existsSync(p.active)) throw new Error('Skill appeared during staging')
      if (existsSync(p.target)) throw new Error('Skill publication target already exists')
      renameSync(p.stage, p.target)
      durable(dirname(p.target)); durable(transaction)
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(`skill.transaction.${journal.id}`, bundle.revision)
    } catch (error) {
      // A durable journal lets rollback prove which files this operation owns.
      if (existsSync(resolve(transaction, 'journal.json'))) recoverOne(journal)
      else rmSync(transaction, { recursive: true, force: true })
      throw error
    }
    // Keep the backup and journal until the enclosing SQLite transaction commits.
  }
  function finish(): void { locked(() => {}) }
  return {
    list(input = {}) {
      return locked(() => {
        const args = skillListArgsSchema.parse(input)
        const diagnostics: { name: string; error: string }[] = []
        const entries: { skill: SkillSummary; score: number }[] = []
        const words = args.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
        for (const name of readdirSync(skillsPath).sort()) {
          try {
            const bundle = current(name)
            const lowerName = bundle.name.toLowerCase()
            const lowerDescription = bundle.description.toLowerCase()
            if (words.some(word => !lowerName.includes(word) && !lowerDescription.includes(word))) continue
            const score = words.reduce((sum, word) => sum + (lowerName === word ? 4 : lowerName.includes(word) ? 2 : 1), 0)
            entries.push({ skill: { name: bundle.name, description: bundle.description, revision: bundle.revision }, score })
          } catch (error) { diagnostics.push({ name, error: errorText(error) }) }
        }
        entries.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name, 'en'))
        return { skills: entries.slice(args.offset, args.offset + args.limit).map(entry => entry.skill), total: entries.length, diagnostics }
      })
    },
    get(name) { return locked(() => details(current(name))) },
    readFile(input) {
      return locked(() => {
        const args = skillReadFileArgsSchema.parse(input)
        const bundle = current(args.name)
        checkRevision(bundle, args.expectedRevision)
        const file = bundle.files.find(file => file.path === args.path)
        if (!file) throw new Error(`Skill file not found: ${args.path}`)
        return file
      })
    },
    write(input) {
      const result = locked(() => {
        const args = skillWriteArgsSchema.parse(input)
        const previous = existsSync(activePath(args.name)) ? current(args.name) : undefined
        checkRevision(previous, args.expectedRevision)
        const files = new Map(previous?.files.map(file => [file.path, file]) ?? [])
        for (const path of args.removeFiles) files.delete(path)
        for (const file of args.files) files.set(file.path, file)
        const bundle = createBundle([...files.values()], args.name)
        publish(bundle, previous?.revision ?? null, { kind: 'write' })
        return details(bundle)
      })
      finish()
      return result
    },
    archive(input) {
      const result = locked(() => {
        const args = skillArchiveArgsSchema.parse(input)
        const base = `${args.name}-${args.expectedRevision}`
        if (!existsSync(activePath(args.name))) {
          for (const entry of readdirSync(archivesPath).sort()) {
            if ((entry === base || entry.startsWith(`${base}-`)) && matches(safe(resolve(archivesPath, entry)), args.name, args.expectedRevision)) return { name: args.name, revision: args.expectedRevision, archived: `archive/skills/${entry}` }
          }
        }
        const bundle = current(args.name)
        checkRevision(bundle, args.expectedRevision)
        const basename = existsSync(safe(resolve(archivesPath, base))) ? `${base}-${randomUUID()}` : base
        publish(bundle, bundle.revision, { kind: 'archive', basename })
        return { name: args.name, revision: bundle.revision, archived: `archive/skills/${basename}` }
      })
      finish()
      return result
    },
  }
}
