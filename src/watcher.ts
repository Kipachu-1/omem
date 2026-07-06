/**
 * Vault file watcher: initial sync + live file events + optional periodic
 * full-sync sweep + optional git sync.
 *
 * Extracted from cli.ts — the 108-line startWatcher was a god fn mixing
 * chokidar debounce + git pull + poll + embed-pass.
 */
import { relative, sep } from 'node:path'
import { fullIndex, indexFile, deleteNote, embedPending, SKIP_DIRS } from './indexer.ts'
import type { DB } from './db.ts'
import type { Embedder } from './embed.ts'
import { stamp, ok, warn, yellow, red, dim, bold, spin } from './ui.ts'

/** One embedder per process: the ONNX session loads once, not per file-save event. */
export async function embedAll(db: DB, embedder: Embedder): Promise<void> {
  const pending = (db.prepare('SELECT count(*) n FROM chunks WHERE embedding IS NULL').get() as { n: number }).n
  if (!pending) return
  const s = spin(`embedding ${pending} chunk${pending === 1 ? '' : 's'}`)
  try {
    const n = await embedPending(db, embedder)
    s.done()
    if (n) ok(`embedded ${n} chunk${n === 1 ? '' : 's'}`)
  } catch (e) {
    s.done()
    warn(`embedding failed (${(e as Error).message}) — search is keyword-only until the next index run`)
  }
}

/** Initial sync + live file events + optional periodic full-sync sweep + optional git sync. */
export async function startWatcher(
  db: DB,
  vault: string,
  pollSec: number,
  gitPullSec: number | undefined,
  embedder: Embedder,
): Promise<void> {
  const { default: chokidar } = await import('chokidar')
  let queue = Promise.resolve()
  const enqueue = (fn: () => void | Promise<void>) => {
    queue = queue.then(fn).catch(e => console.error('watch error:', e))
  }
  const timers = new Map<string, NodeJS.Timeout>()
  const debounced = (rel: string, fn: () => void) => {
    clearTimeout(timers.get(rel))
    timers.set(rel, setTimeout(() => (timers.delete(rel), fn()), 500))
  }
  const relOf = (abs: string) => relative(vault, abs).split(sep).join('/')
  const isMd = (rel: string) => rel.toLowerCase().endsWith('.md')
  const isIgnored = (abs: string) =>
    relOf(abs)
      .split('/')
      .some(part => part.startsWith('.') || SKIP_DIRS.has(part))

  let lastFsEventAt = 0

  const onWrite = (abs: string): void => {
    lastFsEventAt = Date.now()
    const rel = relOf(abs)
    if (!isMd(rel)) return
    debounced(rel, () =>
      enqueue(async () => {
        try {
          if (indexFile(db, vault, rel)) {
            console.error(`${stamp()} ${yellow('~')} ${rel}`)
            await embedAll(db, embedder)
          }
        } catch (e) {
          // deleted between event and read: the unlink event handles it
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      }),
    )
  }

  // watcher first, initial sync queued behind 'ready': no lost-event window between scan and watch
  chokidar
    .watch(vault, { ignored: isIgnored, ignoreInitial: true })
    .on('add', onWrite)
    .on('change', onWrite)
    .on('unlink', abs => {
      lastFsEventAt = Date.now()
      const rel = relOf(abs)
      if (isMd(rel)) debounced(rel, () => enqueue(() => (deleteNote(db, rel), console.error(`${stamp()} ${red('-')} ${rel}`))))
    })
    .on('ready', () =>
      enqueue(async () => {
        const s = fullIndex(db, vault)
        ok(`indexed ${s.indexed}, removed ${s.removed}, unchanged ${s.unchanged} — watching ${bold(vault)}`)
        await embedAll(db, embedder)
      }),
    )

  // periodic full-sync sweep: hash-diffed, so a quiet vault costs ~nothing;
  // catches anything file events missed and repairs external index damage
  if (pollSec > 0) {
    console.error(dim(`full-sync sweep every ${pollSec}s`))
    setInterval(
      () =>
        enqueue(async () => {
          const s = fullIndex(db, vault)
          if (s.indexed || s.removed) {
            console.error(`${stamp()} sweep: indexed ${s.indexed}, removed ${s.removed}`)
            await embedAll(db, embedder)
          }
        }),
      pollSec * 1000,
    )
  }

  // git auto-sync: commit+push on dirty ticks; pull on its own slower clock so a
  // read-only machine still receives remote changes
  if (gitPullSec !== undefined) {
    const { createGitSync } = await import('./git.ts')
    const gitSync = createGitSync(vault, () =>
      enqueue(async () => {
        const s = fullIndex(db, vault)
        if (s.indexed || s.removed) {
          console.error(`${stamp()} pulled: indexed ${s.indexed}, removed ${s.removed}`)
          await embedAll(db, embedder)
        }
      }),
    )
    const tickSec = pollSec > 0 ? pollSec : 30
    let lastPullAt = 0
    console.error(dim(`git sync every ${tickSec}s (pull every ${gitPullSec}s)`))
    setInterval(
      () =>
        enqueue(async () => {
          if (Date.now() - lastFsEventAt < 2000) return // mid-save quiescence: ride the next tick
          const pull = Date.now() - lastPullAt >= gitPullSec * 1000
          if (pull) lastPullAt = Date.now()
          await gitSync({ pull })
        }),
      tickSec * 1000,
    )
  }
}
