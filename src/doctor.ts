/**
 * `omem doctor` — one-command health check.
 *
 * Checks: vault exists, db opens, git remote configured, embed model recorded,
 * pending-embedding count, `OMEM_HTTP_TOKEN` set, last-sync age.
 * Returns a structured report and prints a colored summary.
 *
 * `checkDoctor()` is pure (no printing) so tests can assert the shape;
 * `runDoctor()` prints the colored report to stderr and returns the report.
 */
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { openDb, getMeta, type DB } from './db.ts'
import { bold, dim, green, yellow, red, ok, warn } from './ui.ts'

const run = promisify(execFile)

export interface DoctorReport {
  vault: boolean
  vaultPath: string
  db: boolean
  gitRemote: string | null
  embedModel: string | null
  pendingEmbeddings: number
  totalChunks: number
  httpToken: boolean
  lastSync: number | null
  lastSyncAge: string | null
}

export async function checkDoctor(vault: string): Promise<DoctorReport> {
  const vaultOk = existsSync(vault)
  let db: DB | null = null
  let dbOk = false
  let embedModel: string | null = null
  let pendingEmbeddings = 0
  let totalChunks = 0
  let lastSync: number | null = null

  if (vaultOk) {
    try {
      const dbPath = process.env.OMEM_DB_PATH ?? join(vault, '.omem', 'index.db')
      db = openDb(dbPath)
      dbOk = true
      embedModel = getMeta(db, 'embed_model') ?? null
      totalChunks = (db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c
      pendingEmbeddings = (
        db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NULL').get() as { c: number }
      ).c
    } catch {
      dbOk = false
    } finally {
      db?.close()
    }
    // last_sync is a plain file written by createGitSync (not a db meta key)
    try {
      const ls = readFileSync(join(vault, '.omem', 'last_sync'), 'utf8')
      if (ls) lastSync = parseInt(ls, 10)
    } catch {
      // no sync yet — lastSync stays null
    }
  }

  let gitRemote: string | null = null
  if (vaultOk) {
    try {
      gitRemote = (await run('git', ['-C', vault, 'remote', 'get-url', 'origin']).then(r => r.stdout.trim())).replace(
        /\.git$/,
        '',
      ) ?? null
    } catch {
      gitRemote = null
    }
  }

  const httpToken = !!process.env.OMEM_HTTP_TOKEN

  let lastSyncAge: string | null = null
  if (lastSync) {
    const elapsed = Date.now() - lastSync
    if (elapsed < 60_000) lastSyncAge = `${Math.round(elapsed / 1000)}s ago`
    else if (elapsed < 3_600_000) lastSyncAge = `${Math.round(elapsed / 60_000)}m ago`
    else if (elapsed < 86_400_000) lastSyncAge = `${Math.round(elapsed / 3_600_000)}h ago`
    else lastSyncAge = `${Math.round(elapsed / 86_400_000)}d ago`
  }

  return {
    vault: vaultOk,
    vaultPath: vault,
    db: dbOk,
    gitRemote,
    embedModel,
    pendingEmbeddings,
    totalChunks,
    httpToken,
    lastSync,
    lastSyncAge,
  }
}

function row(label: string, pass: boolean, detail: string): string {
  const mark = pass ? green('✓') : yellow('!')
  return `  ${mark} ${bold(label.padEnd(18))} ${detail}`
}

export async function runDoctor(vault: string): Promise<DoctorReport> {
  const r = await checkDoctor(vault)
  console.error(bold('omem doctor') + dim(` — ${vault}`))

  // vault
  console.error(
    row('vault', r.vault, r.vault ? dim('found') : red('NOT FOUND')),
  )
  // db
  console.error(
    row('database', r.db, r.db ? dim('opens') : red('cannot open')),
  )
  // git
  console.error(
    row('git remote', !!r.gitRemote, r.gitRemote ? dim(r.gitRemote) : yellow('no remote (sync disabled)')),
  )
  // embed model
  console.error(
    row(
      'embed model',
      !!r.embedModel,
      r.embedModel ? dim(r.embedModel) : yellow('not indexed yet (run: omem index)'),
    ),
  )
  // pending embeddings
  const embedComplete = r.embedModel !== null && r.pendingEmbeddings === 0
  console.error(
    row(
      'embeddings',
      embedComplete,
      r.totalChunks === 0
        ? dim('no chunks')
        : r.pendingEmbeddings === 0
          ? dim(`all ${r.totalChunks} embedded`)
          : yellow(`${r.pendingEmbeddings}/${r.totalChunks} pending`),
    ),
  )
  // http token
  console.error(
    row(
      'HTTP token',
      r.httpToken,
      r.httpToken ? dim('set (OMEM_HTTP_TOKEN)') : yellow('unset (serve will be open — set OMEM_HTTP_TOKEN)'),
    ),
  )
  // last sync
  console.error(
    row(
      'last sync',
      r.lastSync !== null,
      r.lastSyncAge ? dim(r.lastSyncAge) : yellow('never (run: omem sync)'),
    ),
  )

  const allGood = r.vault && r.db && r.gitRemote && r.embedModel && embedComplete && r.httpToken
  console.error('')
  if (allGood) ok('all checks passed')
  else warn('some checks need attention (marked with !)')

  return r
}
