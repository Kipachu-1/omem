import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, relative, isAbsolute, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { z } from 'zod'
import { createBundle, readBundle, writeBundle, skillNameSchema } from './bundle.ts'
import type { SkillBundle } from './bundle.ts'
import type { SkillSource } from './source.ts'

export type SyncReport = {
  source: string; installed: string[]; updated: string[]; removed: string[]; unchanged: string[]
  conflicts: { name: string; path: string; reason: string }[]
  diagnostics: { name: string; error: string }[]; reload: string[]; backups: string[]
}
export type SyncOptions = {
  source: SkillSource; home?: string; stateDir?: string; claude?: boolean; legacyWindsurf?: boolean
  adopt?: boolean; overwriteLocal?: boolean
}
const aliasSchema = z.object({ path: z.string(), kind: z.enum(['symlink', 'copy']), fingerprint: z.string() })
const ownedSchema = z.object({ name: skillNameSchema, source: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), path: z.string(), aliases: z.array(aliasSchema) })
type Owned = z.infer<typeof ownedSchema>
type Alias = z.infer<typeof aliasSchema>
const operationSchema = z.object({ target: z.string(), stage: z.string().nullable(), backup: z.string(), existed: z.boolean(), fingerprint: z.string().nullable() })
const journalSchema = z.object({ home: z.string(), operations: z.array(operationSchema) })
type Operation = z.infer<typeof operationSchema>
const lastSchema = z.object({ source: z.string(), time: z.string(), result: z.unknown().nullable(), error: z.string().nullable() })

function location(options: { home?: string; stateDir?: string }) {
  const home = resolve(options.home ?? homedir())
  const stateDir = resolve(options.stateDir ?? join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'omem'))
  plainPath(home, true)
  plainPath(stateDir, true)
  for (const name of ['skills-sync.db', 'skills-sync-lock.db']) for (const suffix of ['', '-wal', '-shm', '-journal']) plainPath(join(stateDir, name + suffix), false)
  return { home, stateDir, database: join(stateDir, 'skills-sync.db') }
}
function plainPath(path: string, directory: boolean) {
  const root = parse(path).root
  let current = root
  const parts = relative(root, path).split(/[\\/]/)
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    if (!present(current)) continue
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() && !(process.platform === 'darwin' && ['/var', '/tmp'].includes(current))) throw new Error(`Skill state or home path is a symlink: ${current}`)
    if (!stat.isSymbolicLink() && (index < parts.length - 1 || directory) && !stat.isDirectory()) throw new Error(`Skill state or home path is not a directory: ${current}`)
  }
}
function nativeTarget(home: string, path: string, name: string) {
  skillNameSchema.parse(name)
  const roots = [join(home, '.agents', 'skills'), join(home, '.claude', 'skills'), join(home, '.codeium', 'windsurf', 'skills')]
  if (!roots.some(root => path === join(root, name))) throw new Error(`Stored native skill path is outside the managed roots: ${path}`)
  safeRoot(home, path)
}
function identify(db: Database.Database, id: number, allowed: string[], write: boolean) {
  const actual = z.number().parse(db.pragma('application_id', { simple: true }))
  if (actual !== 0 && actual !== id) throw new Error('Skill state path contains an unrelated SQLite database')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => z.object({ name: z.string() }).parse(row).name)
  if (tables.some(name => !allowed.includes(name))) throw new Error('Skill state path contains an unrelated SQLite database')
  if (write) db.pragma(`application_id = ${id}`)
}
function schema(db: Database.Database) {
  identify(db, 0x4f534b53, ['installed', 'sync_meta'], true)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.pragma('busy_timeout = 10000')
  db.exec(`CREATE TABLE IF NOT EXISTS installed (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
}
function setMeta(db: Database.Database, key: string, value: unknown) {
  db.prepare('INSERT INTO sync_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
}
function meta(db: Database.Database, key: string): unknown {
  const row = z.object({ value: z.string() }).optional().parse(db.prepare('SELECT value FROM sync_meta WHERE key=?').get(key))
  return row ? JSON.parse(row.value) : undefined
}
function ownership(db: Database.Database): Owned[] {
  return db.prepare('SELECT value FROM installed ORDER BY name').all().map(row => ownedSchema.parse(JSON.parse(z.object({ value: z.string() }).parse(row).value)))
}
function present(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
function safeRoot(home: string, path: string) {
  const rel = relative(home, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Native skill path escapes home: ${path}`)
  let current = home
  for (const part of rel.split(/[\\/]/).slice(0, -1)) {
    current = join(current, part)
    if (present(current) && (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())) throw new Error(`Native skill root is not a plain directory: ${current}`)
  }
}
function fingerprint(path: string, name: string): string | null {
  if (!present(path)) return null
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return `link:${resolve(dirname(path), readlinkSync(path))}`
  if (!stat.isDirectory()) return 'invalid:file'
  try { return `bundle:${readBundle(path, name).revision}` } catch { return 'invalid:bundle' }
}
function aliasExpected(alias: Alias): string { return alias.fingerprint }
function aliasRoots(home: string, options: SyncOptions): string[] {
  return [options.claude ? join(home, '.claude', 'skills') : null,
    options.legacyWindsurf ? join(home, '.codeium', 'windsurf', 'skills') : null].filter((path): path is string => path !== null)
}
function stageAlias(target: string, canonical: string, stagedBundle: string, revision: string): { stage: string; alias: Alias } {
  const stage = join(dirname(target), `.omem-stage-${randomUUID()}`)
  try {
    symlinkSync(canonical, stage, 'dir')
    return { stage, alias: { path: target, kind: 'symlink', fingerprint: `link:${canonical}` } }
  } catch (error) {
    if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || !['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) throw error
    cpSync(stagedBundle, stage, { recursive: true })
    return { stage, alias: { path: target, kind: 'copy', fingerprint: `bundle:${revision}` } }
  }
}
function operation(target: string, stage: string | null, next: string | null): Operation {
  return { target, stage, fingerprint: next, existed: present(target), backup: join(dirname(target), `.omem-backup-${basename(target)}-${randomUUID()}`) }
}
function rollback(home: string, operations: Operation[]) {
  for (const op of [...operations].reverse()) {
    nativeTarget(home, op.target, basename(op.target))
    if (dirname(op.backup) !== dirname(op.target) || !basename(op.backup).startsWith('.omem-backup-')) throw new Error('Invalid interrupted sync backup path')
    safeRoot(home, op.backup)
    if (op.stage) {
      if (dirname(op.stage) !== dirname(op.target) || !basename(op.stage).startsWith('.omem-stage-')) throw new Error('Invalid interrupted sync staging path')
      safeRoot(home, op.stage)
    }
    const hasBackup = present(op.backup)
    const hasTarget = present(op.target)
    const hasStage = op.stage !== null && present(op.stage)
    if (hasStage && hasTarget && hasBackup) throw new Error(`Interrupted sync target was externally created; preserve target, staging and backup at ${op.target}`)
    if ((hasBackup || !op.existed) && !hasStage) {
      if (hasTarget) {
        if (fingerprint(op.target, basename(op.target)) !== op.fingerprint) throw new Error(`Interrupted sync target was edited; preserve and inspect ${op.target}`)
        rmSync(op.target, { recursive: true, force: true })
      }
      if (hasBackup) renameSync(op.backup, op.target)
    }
    if (hasStage && hasBackup && !hasTarget) renameSync(op.backup, op.target)
    if (op.stage) rmSync(op.stage, { recursive: true, force: true })
  }
}
function recover(db: Database.Database, home: string) {
  const raw = meta(db, 'journal')
  if (raw === undefined) return
  const journal = journalSchema.parse(raw)
  if (journal.home !== home) throw new Error('Interrupted skill sync belongs to a different home directory')
  rollback(home, journal.operations)
  flushParents(journal.operations)
  db.prepare("DELETE FROM sync_meta WHERE key='journal'").run()
}
function flush(path: string) {
  if (lstatSync(path).isSymbolicLink()) return
  if (lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) flush(join(path, entry))
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } catch (error) { if (process.platform !== 'win32') throw error } finally { closeSync(descriptor) }
}
function flushParents(operations: Operation[]) {
  for (const parent of new Set(operations.map(op => dirname(op.target)))) {
    const descriptor = openSync(parent, 'r')
    try { fsyncSync(descriptor) } catch (error) { if (process.platform !== 'win32') throw error } finally { closeSync(descriptor) }
  }
}
function publish(db: Database.Database, home: string, name: string, next: Owned | null, operations: Operation[], preserveBackup: boolean, report: SyncReport) {
  for (const op of operations) if (op.stage) flush(op.stage)
  flushParents(operations)
  setMeta(db, 'journal', { home, operations })
  try {
    for (const op of operations) {
      if (op.existed) renameSync(op.target, op.backup)
      if (op.stage) renameSync(op.stage, op.target)
    }
    flushParents(operations)
    db.transaction(() => {
      if (next) db.prepare('INSERT INTO installed(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(next))
      else db.prepare('DELETE FROM installed WHERE name=?').run(name)
      db.prepare("DELETE FROM sync_meta WHERE key='journal'").run()
    })()
  } catch (error) {
    rollback(home, operations)
    flushParents(operations)
    db.prepare("DELETE FROM sync_meta WHERE key='journal'").run()
    throw error
  }
  for (const op of operations) if (present(op.backup)) {
    if (preserveBackup) report.backups.push(op.backup)
    else rmSync(op.backup, { recursive: true, force: true })
  }
}

export function getSkillsSyncStatus(options: { home?: string; stateDir?: string } = {}) {
  const paths = location(options)
  if (!existsSync(paths.database)) return { installed: [], last: null }
  const db = new Database(paths.database, { readonly: true, fileMustExist: true })
  try {
    identify(db, 0x4f534b53, ['installed', 'sync_meta'], false)
    const raw = meta(db, 'last')
    return { installed: ownership(db), last: raw === undefined ? null : lastSchema.parse(raw) }
  } finally { db.close() }
}
function acquireWriter(options: { home?: string; stateDir?: string }) {
  const paths = location(options)
  const lock = new Database(join(paths.stateDir, 'skills-sync-lock.db'))
  try {
    lock.pragma('busy_timeout = 10000')
    identify(lock, 0x4f534b4c, ['mutex'], true)
    lock.exec('CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE')
    return lock
  } catch (error) { lock.close(); throw error }
}
function releaseWriter(lock: Database.Database) {
  if (lock.inTransaction) lock.exec('ROLLBACK')
  lock.close()
}
export function recordSkillsSyncFailure(options: { source: string; error: string; home?: string; stateDir?: string }) {
  const paths = location(options)
  mkdirSync(paths.stateDir, { recursive: true })
  const lock = acquireWriter(options)
  let db: Database.Database | undefined
  try {
    db = new Database(paths.database)
    schema(db)
    recover(db, paths.home)
    setMeta(db, 'last', { source: options.source, time: new Date().toISOString(), result: null, error: options.error })
  } finally { db?.close(); releaseWriter(lock) }
}

export async function syncSkills(options: SyncOptions): Promise<SyncReport> {
  const { source } = options
  const paths = location(options)
  const report: SyncReport = { source: source.id, installed: [], updated: [], removed: [], unchanged: [], conflicts: [], diagnostics: [], reload: [], backups: [] }
  mkdirSync(paths.stateDir, { recursive: true })
  const staging = mkdtempSync(join(paths.stateDir, 'skills-fetch-'))
  let db: Database.Database | undefined
  let initialized = false
  let lock: Database.Database | undefined
  try {
    lock = acquireWriter(options)
    db = new Database(paths.database)
    schema(db)
    initialized = true
    recover(db, paths.home)
    const beforeFetch = new Map(ownership(db).map(entry => [entry.name, entry]))
    releaseWriter(lock)
    lock = undefined
    const catalogue = await source.list()
    report.diagnostics = catalogue.diagnostics
    const bundles = new Map<string, SkillBundle>()
    const invalid = new Set(catalogue.diagnostics.map(entry => entry.name))
    const names = new Set<string>()
    for (const summary of catalogue.skills) {
      if (names.has(summary.name)) throw new Error('Skill catalogue contains duplicate names')
      names.add(summary.name)
      if (invalid.has(summary.name)) continue
      const downloaded = await source.get(summary.name)
      const bundle = createBundle(downloaded.files, summary.name)
      if (bundle.revision !== summary.revision || bundle.revision !== downloaded.revision) throw new Error(`Skill ${summary.name} changed during sync; retry`)
      bundles.set(bundle.name, bundle)
      writeBundle(join(staging, bundle.name), bundle.files)
    }
    const confirmed = await source.list()
    const catalogueKey = (entries: typeof catalogue) => JSON.stringify({ skills: entries.skills.map(skill => [skill.name, skill.revision]).sort(), total: entries.total, diagnostics: entries.diagnostics })
    if (catalogueKey(confirmed) !== catalogueKey(catalogue)) throw new Error('Skill catalogue changed during download; retry sync')
    // A separate database keeps the publishing mutex held while journal commits remain durable.
    lock = acquireWriter(options)
    recover(db, paths.home)
    const installed = ownership(db)
    for (const entry of installed) {
      nativeTarget(paths.home, entry.path, entry.name)
      for (const alias of entry.aliases) nativeTarget(paths.home, alias.path, entry.name)
    }
    const owned = new Map(installed.map(entry => [entry.name, entry]))
    const root = join(paths.home, '.agents', 'skills')
    safeRoot(paths.home, join(root, 'check'))
    mkdirSync(root, { recursive: true })
    const aliases = aliasRoots(paths.home, options)
    function conflict(name: string, path: string, reason: string) { report.conflicts.push({ name, path, reason }) }
    for (const [name, bundle] of bundles) {
      const target = join(root, name)
      safeRoot(paths.home, target)
      const skillAliases = aliases.filter(aliasRoot => {
        if (aliasRoot !== join(paths.home, '.claude', 'skills') || !['synced', 'anthropic-skills'].includes(name)) return true
        conflict(name, join(aliasRoot, name), 'Claude Code reserves this name; the shared copy is available but no Claude alias will be installed')
        return false
      })
      const previous = owned.get(name)
      if (JSON.stringify(previous) !== JSON.stringify(beforeFetch.get(name))) {
        conflict(name, target, 'Native installation changed during download; retry sync')
        continue
      }
      if (previous && (previous.source !== source.id || previous.path !== target)) {
        conflict(name, target, 'Skill is managed by another source or home directory')
        continue
      }
      const actual = fingerprint(target, name)
      const desired = `bundle:${bundle.revision}`
      const expected = previous ? `bundle:${previous.revision}` : null
      const changedLocally = actual !== expected && actual !== null
      if (changedLocally && !(options.adopt && actual === desired) && !options.overwriteLocal) {
        conflict(name, target, previous ? 'Managed skill was edited locally' : 'Skill is not managed by omem; use --adopt for an identical copy or --overwrite-local')
        continue
      }
      const operations: Operation[] = []
      const nextAliases: Alias[] = []
      let blocked = false
      for (const alias of previous?.aliases ?? []) {
        try { safeRoot(paths.home, alias.path) } catch (error) {
          conflict(name, alias.path, error instanceof Error ? error.message : String(error)); blocked = true; continue
        }
        const current = fingerprint(alias.path, name)
        if (current !== null && current !== aliasExpected(alias) && !options.overwriteLocal) {
          conflict(name, alias.path, 'Managed alias was edited locally'); blocked = true
        }
      }
      for (const aliasRoot of skillAliases) {
        const aliasPath = join(aliasRoot, name)
        try { safeRoot(paths.home, aliasPath) } catch (error) {
          conflict(name, aliasPath, error instanceof Error ? error.message : String(error)); blocked = true; continue
        }
        const oldAlias = previous?.aliases.find(alias => alias.path === aliasPath)
        const current = fingerprint(aliasPath, name)
        const desiredAlias = `link:${target}`
        if (!oldAlias && current !== null && !(options.adopt && (current === desiredAlias || current === desired)) && !options.overwriteLocal) {
          conflict(name, aliasPath, 'Alias is not managed by omem'); blocked = true
        }
      }
      if (blocked) continue
      const garbage: string[] = []
      try {
        if (actual !== desired) {
          const stage = join(root, `.omem-stage-${randomUUID()}`)
          cpSync(join(staging, name), stage, { recursive: true })
          garbage.push(stage)
          operations.push(operation(target, stage, desired))
        }
        for (const aliasRoot of skillAliases) {
          mkdirSync(aliasRoot, { recursive: true })
          const aliasPath = join(aliasRoot, name)
          const prior = previous?.aliases.find(alias => alias.path === aliasPath)
          const current = fingerprint(aliasPath, name)
          if (current === `link:${target}`) nextAliases.push({ path: aliasPath, kind: 'symlink', fingerprint: current })
          else if (prior?.kind === 'copy' && current === desired) nextAliases.push({ ...prior, fingerprint: desired })
          else {
            const prepared = stageAlias(aliasPath, target, join(staging, name), bundle.revision)
            garbage.push(prepared.stage)
            nextAliases.push(prepared.alias)
            operations.push(operation(aliasPath, prepared.stage, prepared.alias.fingerprint))
          }
        }
        for (const oldAlias of previous?.aliases ?? []) if (!nextAliases.some(alias => alias.path === oldAlias.path) && present(oldAlias.path)) operations.push(operation(oldAlias.path, null, null))
        const next: Owned = { name, source: source.id, revision: bundle.revision, path: target, aliases: nextAliases }
        publish(db, paths.home, name, next, operations, Boolean(options.overwriteLocal && (changedLocally || operations.some(op => op.existed && op.target !== target))), report)
        if (!previous) report.installed.push(name)
        else if (previous.revision !== bundle.revision || operations.length) report.updated.push(name)
        else report.unchanged.push(name)
      } finally {
        if (meta(db, 'journal') === undefined) for (const path of garbage) rmSync(path, { recursive: true, force: true })
      }
    }
    // Diagnostics mean the catalogue may be incomplete. Retain every last-good installation.
    if (report.diagnostics.length === 0) for (const previous of owned.values()) {
      if (previous.source !== source.id || names.has(previous.name)) continue
      if (JSON.stringify(previous) !== JSON.stringify(beforeFetch.get(previous.name))) {
        conflict(previous.name, previous.path, 'Native installation changed during download; retry sync')
        continue
      }
      const targets = [previous.path, ...previous.aliases.map(alias => alias.path)]
      let blocked = false
      for (const path of targets) {
        try { safeRoot(paths.home, path) } catch (error) {
          conflict(previous.name, path, error instanceof Error ? error.message : String(error)); blocked = true; continue
        }
        const actual = fingerprint(path, previous.name)
        const expected = path === previous.path ? `bundle:${previous.revision}` : previous.aliases.find(alias => alias.path === path)?.fingerprint
        if (actual !== null && actual !== expected) { conflict(previous.name, path, 'Archived skill or alias was edited locally; retained'); blocked = true }
      }
      if (blocked) continue
      publish(db, paths.home, previous.name, null, targets.filter(present).map(path => operation(path, null, null)), false, report)
      report.removed.push(previous.name)
    }
    if (report.installed.length || report.updated.length || report.removed.length) report.reload = ['Restart or reload active agent sessions to discover changed skills.']
    setMeta(db, 'last', { source: source.id, time: new Date().toISOString(), result: report, error: null })
    return report
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (db && initialized) setMeta(db, 'last', { source: source.id, time: new Date().toISOString(), result: report, error: message })
    else if (!lock) {
      try { recordSkillsSyncFailure({ ...paths, source: source.id, error: message }) } catch { /* Preserve the original failure when state cannot be written safely. */ }
    }
    throw error
  } finally {
    db?.close()
    if (lock) releaseWriter(lock)
    rmSync(staging, { recursive: true, force: true })
  }
}
