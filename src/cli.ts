#!/usr/bin/env node
import { applyEnvDefaults } from './config.ts'
import { parseArgs } from 'node:util'
import { existsSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// must run before anything reads env-derived values (config file + .env fill the gaps)
applyEnvDefaults()
import { openDb, getMeta, type DB } from './db.ts'
import { fullIndex, indexFile, deleteNote, embedPending, SKIP_DIRS } from './indexer.ts'
import { localEmbedder, defaultModel } from './embed.ts'
import { search } from './search.ts'

const USAGE = `omem — obsidian vault memory index

usage: omem <command> [options]

  setup    interactive setup — writes ~/.config/omem/config.json (start here)
  index    full sync (incremental via content hashes)
  watch    sync, then watch the vault and index changes live [--poll N: also full-sync every N seconds]
  serve    watch + MCP server on stdio (the normal run mode; --poll defaults to 30)
  search   query the index:  omem search "how does X work" [--json] [--limit N] [--folder F] [--tag T] [--keyword-only]
  sync     git commit + pull + push the vault once (cron-friendly)
  rebuild  drop the index and re-sync from scratch
  stats    note/chunk/edge counts, pending embeddings

git: --git (or OMEM_GIT=1) on watch/serve auto-commits+pushes dirty ticks and pulls
     every --git-pull-interval seconds (default 300)

options: --vault <path> (or OMEM_VAULT); db lives at <vault>/.omem/index.db (or OMEM_DB_PATH)
model: ${defaultModel()} (or OMEM_EMBED_MODEL)

first time? run: omem setup`

const { values, positionals } = parseArgs({
  options: {
    vault: { type: 'string' },
    json: { type: 'boolean' },
    limit: { type: 'string' },
    folder: { type: 'string' },
    tag: { type: 'string', multiple: true },
    'keyword-only': { type: 'boolean' },
    poll: { type: 'string' },
    git: { type: 'boolean' },
    'git-pull-interval': { type: 'string' },
  },
  allowPositionals: true,
})

const [cmd, ...rest] = positionals

function vaultPath(): string {
  const v = values.vault ?? process.env.OMEM_VAULT
  if (!v) {
    console.error('error: no vault — pass --vault <path>, set OMEM_VAULT, or run: omem setup')
    process.exit(1)
  }
  if (!existsSync(v)) {
    console.error(`error: vault not found: ${v}`)
    process.exit(1)
  }
  return v
}

function dbPath(vault: string): string {
  return process.env.OMEM_DB_PATH ?? join(vault, '.omem', 'index.db')
}

// one embedder per process: the ONNX session loads once, not per file-save event
const embedder = localEmbedder()

async function embedAll(db: DB): Promise<void> {
  try {
    const n = await embedPending(db, embedder)
    if (n) console.error(`embedded ${n} chunks`)
  } catch (e) {
    console.error(`warning: embedding failed (${(e as Error).message}) — search is keyword-only until the next index run`)
  }
}

function parseLimit(): number | undefined {
  if (values.limit === undefined) return undefined
  const n = Number(values.limit)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`error: --limit must be a positive integer, got "${values.limit}"`)
    process.exit(1)
  }
  return n
}

function parsePoll(fallback: number): number {
  const raw = values.poll ?? process.env.OMEM_POLL
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`error: --poll / OMEM_POLL must be a positive integer (seconds), got "${raw}"`)
    process.exit(1)
  }
  return n
}

/** undefined = git sync disabled; number = pull interval in seconds */
function gitPullSec(): number | undefined {
  if (!values.git && process.env.OMEM_GIT !== '1') return undefined
  const raw = values['git-pull-interval'] ?? process.env.OMEM_GIT_PULL_INTERVAL
  if (raw === undefined) return 300
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`error: --git-pull-interval / OMEM_GIT_PULL_INTERVAL must be a positive integer (seconds), got "${raw}"`)
    process.exit(1)
  }
  return n
}

/** Initial sync + live file events + optional periodic full-sync sweep + optional git sync. */
async function startWatcher(db: DB, vault: string, pollSec: number, gitPullSec?: number): Promise<void> {
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
            console.error(`~ ${rel}`)
            await embedAll(db)
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
      if (isMd(rel)) debounced(rel, () => enqueue(() => (deleteNote(db, rel), console.error(`- ${rel}`))))
    })
    .on('ready', () =>
      enqueue(async () => {
        const s = fullIndex(db, vault)
        console.error(`indexed ${s.indexed}, removed ${s.removed}, unchanged ${s.unchanged} — watching ${vault}`)
        await embedAll(db)
      }),
    )

  // periodic full-sync sweep: hash-diffed, so a quiet vault costs ~nothing;
  // catches anything file events missed and repairs external index damage
  if (pollSec > 0) {
    console.error(`full-sync sweep every ${pollSec}s`)
    setInterval(
      () =>
        enqueue(async () => {
          const s = fullIndex(db, vault)
          if (s.indexed || s.removed) {
            console.error(`sweep: indexed ${s.indexed}, removed ${s.removed}`)
            await embedAll(db)
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
          console.error(`pulled: indexed ${s.indexed}, removed ${s.removed}`)
          await embedAll(db)
        }
      }),
    )
    const tickSec = pollSec > 0 ? pollSec : 30
    let lastPullAt = 0
    console.error(`git sync every ${tickSec}s (pull every ${gitPullSec}s)`)
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

async function main(): Promise<void> {
  switch (cmd) {
    case 'index': {
      const vault = vaultPath()
      const db = openDb(dbPath(vault))
      const s = fullIndex(db, vault)
      console.error(`indexed ${s.indexed}, removed ${s.removed}, unchanged ${s.unchanged}`)
      await embedAll(db)
      break
    }

    case 'rebuild': {
      const vault = vaultPath()
      const p = dbPath(vault)
      for (const f of [p, p + '-wal', p + '-shm']) rmSync(f, { force: true })
      const db = openDb(p)
      const s = fullIndex(db, vault)
      console.error(`indexed ${s.indexed} notes from scratch`)
      await embedAll(db)
      break
    }

    case 'search': {
      const query = rest.join(' ').trim()
      if (!query) {
        console.error('usage: omem search "your query"')
        process.exit(1)
      }
      const vault = vaultPath()
      const db = openDb(dbPath(vault))
      const results = await search(db, query, {
        limit: parseLimit(),
        folder: values.folder,
        tags: values.tag,
        embedder: values['keyword-only'] ? null : embedder,
      })
      if (values.json) {
        console.log(JSON.stringify(results, null, 2))
      } else if (!results.length) {
        console.log('no results')
      } else {
        for (const r of results) {
          const loc = r.heading ? `${r.notePath} § ${r.heading}` : r.notePath
          console.log(`\n[${r.score.toFixed(4)} ${r.matchType}] ${r.title}  (${loc})`)
          console.log(r.text.length > 300 ? r.text.slice(0, 300) + '…' : r.text)
        }
      }
      break
    }

    case 'watch': {
      const vault = vaultPath()
      await startWatcher(openDb(dbPath(vault)), vault, parsePoll(0), gitPullSec())
      break
    }

    case 'serve': {
      const vault = vaultPath()
      const db = openDb(dbPath(vault))
      // sync before accepting tool calls so the first search never sees an empty index;
      // embeddings fill in asynchronously via the watcher's ready-pass
      const s = fullIndex(db, vault)
      console.error(`initial sync: indexed ${s.indexed}, removed ${s.removed}, unchanged ${s.unchanged}`)
      await startWatcher(db, vault, parsePoll(30), gitPullSec())
      const { serveMcp } = await import('./mcp.ts')
      await serveMcp(db, vault, embedder)
      break
    }

    case 'setup': {
      const { runSetup } = await import('./setup.ts')
      await runSetup()
      break
    }

    case 'sync': {
      const vault = vaultPath()
      const { createGitSync } = await import('./git.ts')
      const r = await createGitSync(vault)({ pull: true })
      console.error(
        r.skipped
          ? `skipped: ${r.skipped}`
          : `committed ${r.committed}, pulled: ${r.pulled}, pushed ${r.pushed}${r.ok ? '' : ' — with errors'}`,
      )
      process.exit(r.ok ? 0 : 1)
    }

    case 'stats': {
      const vault = vaultPath()
      const db = openDb(dbPath(vault))
      const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n
      console.log(`notes:              ${one('SELECT count(*) n FROM notes')}`)
      console.log(`chunks:             ${one('SELECT count(*) n FROM chunks')}`)
      console.log(`pending embeddings: ${one('SELECT count(*) n FROM chunks WHERE embedding IS NULL')}`)
      console.log(`wikilink edges:     ${one("SELECT count(*) n FROM edges WHERE type = 'wikilink'")}`)
      console.log(`unresolved links:   ${one("SELECT count(*) n FROM edges WHERE type = 'wikilink' AND resolved = 0")}`)
      console.log(`tag edges:          ${one("SELECT count(*) n FROM edges WHERE type = 'tag'")}`)
      console.log(`embed model:        ${getMeta(db, 'embed_model') ?? '(none yet)'}`)
      break
    }

    default:
      console.log(USAGE)
      process.exit(cmd ? 1 : 0)
  }
}

await main()
