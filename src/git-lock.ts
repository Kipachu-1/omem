import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export type GitLease = (() => Promise<void>) | null

/** A separate SQLite writer transaction provides a crash-safe lease on platforms without flock. */
export function acquireSqliteGitLease(lock: string): GitLease {
  const db = new Database(`${lock}.sqlite`, { timeout: 0 })
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (error) {
    db.close()
    if (error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY') return null
    throw error
  }
  return async () => {
    try { db.exec('ROLLBACK') } finally { db.close() }
  }
}

/** Linux retains flock interoperability; only its explicit contention exit means held. */
export async function acquireGitLease(lock: string): Promise<GitLease> {
  if (process.platform !== 'linux') return acquireSqliteGitLease(lock)
  const holder = spawn('flock', ['-n', '-E', '75', lock, 'sh', '-c', 'echo acquired >&2; cat >/dev/null'], {
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  const acquired = await new Promise<boolean>((resolve, reject) => {
    let stderr = ''
    holder.stderr.on('data', chunk => {
      stderr += chunk
      if (stderr.includes('acquired\n')) resolve(true)
    })
    holder.once('error', reject)
    holder.once('exit', (code, signal) => {
      if (code === 75) resolve(false)
      else reject(new Error(stderr.trim() || `flock exited with ${signal ?? code}`))
    })
  })
  if (!acquired) return null
  return async () => {
    if (holder.exitCode !== null || holder.signalCode !== null) return
    const exited = once(holder, 'exit')
    holder.stdin.end()
    await exited
  }
}
