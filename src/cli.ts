#!/usr/bin/env node
import { applyEnvDefaults } from './config.ts'
import { parseArgs } from 'node:util'
import { existsSync, rmSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

// must run before anything reads env-derived values (config file + .env fill the gaps)
applyEnvDefaults()
import { openDb, getMeta, type DB } from './db.ts'
import { fullIndex, indexFile, deleteNote, embedPending, SKIP_DIRS } from './indexer.ts'
import { localEmbedder, defaultModel } from './embed.ts'
import { search, type MatchType } from './search.ts'
import { bold, dim, cyan, green, yellow, magenta, red, ok, warn, fail, stamp, spin } from './ui.ts'

const cmdLine = (name: string, desc: string) => `  ${cyan(name.padEnd(8))} ${desc}`
const USAGE = `${bold('omem')} — obsidian vault memory index

${dim('usage:')} omem ${cyan('<command>')} [options]

${cmdLine('setup', 'interactive setup — writes ~/.config/omem/config.json ' + bold('(start here)'))}
${cmdLine('init', 'create a new vault at <path> from the starter template (git init + first commit)')}
${cmdLine('index', 'full sync (incremental via content hashes)')}
${cmdLine('watch', 'sync, then watch the vault and index changes live ' + dim('[--poll N: also full-sync every N seconds]'))}
${cmdLine('serve', `watch + MCP server on stdio (the normal run mode; --poll defaults to 30)
           ${dim('--port N serves MCP over HTTP instead; set OMEM_HTTP_TOKEN to require bearer auth')}`)}
${cmdLine('search', `query the index:  omem search "how does X work" ${dim('[--json] [--limit N] [--folder F] [--tag T] [--after D] [--before D] [--keyword-only]')}`)}
${cmdLine('sync', 'git commit + pull + push the vault once (cron-friendly)')}
${cmdLine('rebuild', 'drop the index and re-sync from scratch')}
${cmdLine('stats', 'note/chunk/edge counts, pending embeddings')}
${cmdLine('agents', 'detect installed agent tools (Claude Code, Codex, pi, Cursor, …) and register the MCP server')}
${cmdLine('update', 'self-update to the latest npm release')}

${dim('git:')} --git (or OMEM_GIT=1) on watch/serve auto-commits+pushes dirty ticks and pulls
     every --git-pull-interval seconds (default 300)

${dim('options:')} --vault <path> (or OMEM_VAULT); db lives at <vault>/.omem/index.db (or OMEM_DB_PATH)
${dim('model:')} ${defaultModel()} (or OMEM_EMBED_MODEL)

first time? run: ${cyan('omem setup')}`

const { values, positionals } = parseArgs({
  options: {
    vault: { type: 'string' },
    json: { type: 'boolean' },
    limit: { type: 'string' },
    folder: { type: 'string' },
    tag: { type: 'string', multiple: true },
    after: { type: 'string' },
    before: { type: 'string' },
    'keyword-only': { type: 'boolean' },
    poll: { type: 'string' },
    port: { type: 'string' },
    git: { type: 'boolean' },
    'git-pull-interval': { type: 'string' },
  },
  allowPositionals: true,
})

const [cmd, ...rest] = positionals

function vaultPath(): string {
  const v = values.vault ?? process.env.OMEM_VAULT
  if (!v) {
    fail(`no vault — pass --vault <path>, set OMEM_VAULT, or run: ${cyan('omem setup')}`)
    process.exit(1)
  }
  if (!existsSync(v)) {
    fail(`vault not found: ${v}`)
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

function parseLimit(): number | undefined {
  if (values.limit === undefined) return undefined
  const n = Number(values.limit)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`error: --limit must be a positive integer, got "${values.limit}"`)
    process.exit(1)
  }
  return n
}

/** Accept either an ISO-8601 date or a ms-epoch integer; undefined = unset. */
function parseTime(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  // pure integer -> treat as ms epoch; otherwise try ISO-8601
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) {
      console.error(`error: ${flag} must be an ISO-8601 date or ms-epoch integer, got "${raw}"`)
      process.exit(1)
    }
    return n
  }
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) {
    console.error(`error: ${flag} must be an ISO-8601 date or ms-epoch integer, got "${raw}"`)
    process.exit(1)
  }
  return ms
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
            console.error(`${stamp()} ${yellow('~')} ${rel}`)
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
      if (isMd(rel)) debounced(rel, () => enqueue(() => (deleteNote(db, rel), console.error(`${stamp()} ${red('-')} ${rel}`))))
    })
    .on('ready', () =>
      enqueue(async () => {
        const s = fullIndex(db, vault)
        ok(`indexed ${s.indexed}, removed ${s.removed}, unchanged ${s.unchanged} — watching ${bold(vault)}`)
        await embedAll(db)
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
          console.error(`${stamp()} pulled: indexed ${s.indexed}, removed ${s.removed}`)
          await embedAll(db)
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

async function main(): Promise<void> {
  switch (cmd) {
    case 'index': {
      const vault = vaultPath()
      const db = openDb(dbPath(vault))
      const sp = spin('indexing')
      const s = fullIndex(db, vault)
      sp.done()
      ok(`indexed ${s.indexed}, removed ${s.removed}, unchanged ${s.unchanged}`)
      await embedAll(db)
      break
    }

    case 'rebuild': {
      const vault = vaultPath()
      const p = dbPath(vault)
      for (const f of [p, p + '-wal', p + '-shm']) rmSync(f, { force: true })
      const db = openDb(p)
      const sp = spin('rebuilding index')
      const s = fullIndex(db, vault)
      sp.done()
      ok(`indexed ${s.indexed} notes from scratch`)
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
      const sp = spin(`searching "${query}"`)
      const results = await search(db, query, {
        limit: parseLimit(),
        folder: values.folder,
        tags: values.tag,
        after: parseTime(values.after, '--after'),
        before: parseTime(values.before, '--before'),
        embedder: values['keyword-only'] ? null : embedder,
      })
      sp.done()
      if (values.json) {
        console.log(JSON.stringify(results, null, 2))
      } else if (!results.length) {
        console.log(dim('no results'))
      } else {
        const tint: Record<MatchType, (s: string) => string> = {
          both: magenta,
          vector: cyan,
          keyword: yellow,
          graph: green,
        }
        for (const r of results) {
          const loc = r.heading ? `${r.notePath} § ${r.heading}` : r.notePath
          console.log(`\n${tint[r.matchType](`● ${r.score.toFixed(3)} ${r.matchType}`)} ${bold(r.title)}  ${dim(loc)}`)
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
      ok(`initial sync: indexed ${s.indexed}, removed ${s.removed}, unchanged ${s.unchanged}`)
      await startWatcher(db, vault, parsePoll(30), gitPullSec())
      const { serveMcp, serveHttp } = await import('./mcp.ts')
      if (values.port !== undefined) {
        const port = Number(values.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          fail(`--port must be 1-65535, got "${values.port}"`)
          process.exit(1)
        }
        await serveHttp(db, vault, embedder, port)
      } else {
        await serveMcp(db, vault, embedder)
      }
      break
    }

    case 'setup': {
      const { runSetup } = await import('./setup.ts')
      await runSetup()
      break
    }

    case 'init': {
      if (!rest[0]) {
        fail(`usage: omem init <path>   e.g. omem init ~/my-vault`)
        process.exit(1)
      }
      const { scaffoldVault, expand } = await import('./setup.ts')
      const dest = resolve(expand(rest[0]))
      if (existsSync(dest) && (statSync(dest).isFile() || readdirSync(dest).length)) {
        fail(`${dest} already exists and is not empty — init only creates new vaults`)
        process.exit(1)
      }
      await scaffoldVault(dest)
      console.error(`\nnext: ${cyan('omem setup')} ${dim(`— point it at ${dest} to configure indexing + git sync`)}`)
      break
    }

    case 'sync': {
      const vault = vaultPath()
      const { createGitSync } = await import('./git.ts')
      const sp = spin('git sync')
      const r = await createGitSync(vault)({ pull: true })
      sp.done()
      if (r.skipped) console.error(dim(`skipped: ${r.skipped}`))
      else {
        const msg = `committed ${r.committed}, pulled: ${r.pulled}, pushed ${r.pushed}`
        r.ok ? ok(msg) : fail(`${msg} — with errors`)
      }
      process.exit(r.ok ? 0 : 1)
    }

    case 'stats': {
      const vault = vaultPath()
      const db = openDb(dbPath(vault))
      const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n
      const row = (label: string, v: string | number) => console.log(`${dim(label.padEnd(20))}${bold(String(v))}`)
      row('notes', one('SELECT count(*) n FROM notes'))
      row('chunks', one('SELECT count(*) n FROM chunks'))
      const pending = one('SELECT count(*) n FROM chunks WHERE embedding IS NULL')
      console.log(`${dim('pending embeddings'.padEnd(20))}${pending ? yellow(String(pending)) : bold('0')}`)
      row('wikilink edges', one("SELECT count(*) n FROM edges WHERE type = 'wikilink'"))
      row('unresolved links', one("SELECT count(*) n FROM edges WHERE type = 'wikilink' AND resolved = 0"))
      row('tag edges', one("SELECT count(*) n FROM edges WHERE type = 'tag'"))
      row('embed model', getMeta(db, 'embed_model') ?? '(none yet)')
      break
    }

    case 'agents': {
      const { offerAgents, detectAgents } = await import('./agents.ts')
      if (!process.stdin.isTTY) {
        // piped/scripted: just report what's detected
        const found = await detectAgents()
        console.log(found.length ? found.map(a => a.name).join('\n') : 'none detected')
        break
      }
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      let open = true
      rl.on('close', () => (open = false))
      // EOF while questions remain answers "no" to the rest instead of crashing readline
      await offerAgents(async q => {
        if (!open) return false
        // setPrompt so readline redraws the question on backspace instead of its default '> '
        rl.setPrompt(`${q} ${dim('[y/N]')} `)
        rl.prompt()
        const line = await new Promise<string>(res => {
          rl.once('line', res)
          rl.once('close', () => res(''))
        })
        return ['y', 'yes'].includes(line.trim().toLowerCase())
      })
      rl.close()
      break
    }

    case 'update': {
      if (existsSync(new URL('../.git', import.meta.url))) {
        warn('repo checkout — update with: git pull')
        break
      }
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const run = promisify(execFile)
      const cur = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
      const sp = spin('checking npm for the latest version')
      let latest: string
      try {
        latest = (await run('npm', ['view', '@kipachu/omem', 'version'])).stdout.trim()
      } catch (e) {
        sp.done()
        fail(`could not reach npm (${(e as Error).message})`)
        process.exit(1)
      }
      sp.done()
      if (latest === cur) {
        ok(`already up to date (v${cur})`)
        break
      }
      const sp2 = spin(`updating v${cur} → v${latest}`)
      try {
        await run('npm', ['install', '-g', '@kipachu/omem@latest'])
        sp2.done()
        ok(`updated v${cur} → v${latest}`)
      } catch (e) {
        sp2.done()
        fail(`npm install failed (${(e as Error).message}) — try: npm i -g @kipachu/omem@latest`)
        process.exit(1)
      }
      break
    }

    default:
      console.log(USAGE)
      process.exit(cmd ? 1 : 0)
  }
}

await main()
