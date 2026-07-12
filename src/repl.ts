/**
 * Interactive REPL — the `omem` command with no args drops here instead of
 * dumping USAGE and exiting. Type a natural-language query → styled search
 * results; slash commands mirror the MCP tool surface (short native names).
 *
 * Pure helpers (`parseSlash`, `SLASH_COMMANDS`, `helpText`) are exported for
 * testing without a TTY.
 */
import { createInterface } from 'node:readline/promises'
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { DB } from './db.ts'
import type { Embedder } from './embed.ts'
import { search, type SearchResult } from './search.ts'
import { vaultStatus } from './status.ts'
import { bold, dim, cyan, green, yellow, magenta, red, ok, warn, spin, bar } from './ui.ts'

/** Every slash command the REPL knows. Keep names short (human-facing);
 *  the MCP mapping lives in helpText(). */
export const SLASH_COMMANDS = [
  'search',
  'recent',
  'status',
  'write',
  'sync',
  'stats',
  'help',
  'quit',
] as const
export type SlashCommand = (typeof SLASH_COMMANDS)[number]

export interface ParsedSlash {
  cmd: string
  args: string[]
}

/** Parse a `/<cmd> arg1 arg2 …` line into {cmd, args}. Bare text returns {cmd:'', args:[text]}. */
export function parseSlash(line: string): ParsedSlash {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return { cmd: '', args: [trimmed] }
  const parts = trimmed.slice(1).split(/\s+/)
  return { cmd: parts[0] ?? '', args: parts.slice(1) }
}

const MCP_MAP: Record<string, string> = {
  search: 'memory_search',
  recent: 'memory_recent',
  status: 'memory_status',
  write: 'memory_write',
  sync: 'memory_sync',
  stats: 'memory_recall',
  help: '—',
  quit: '—',
}

/** `/help` output: each slash command + its MCP equivalent + one-liner. */
export function helpText(): string {
  const rows: [string, string, string][] = [
    ['search', 'memory_search', 'query the vault: /search how does X work'],
    ['recent', 'memory_recent', 'notes changed lately: /recent [limit]'],
    ['status', 'memory_status', 'vault snapshot: notes, chunks, pending, top folders'],
    ['write', 'memory_write', 'create a note: /write <title> — opens an editor line'],
    ['sync', 'memory_sync', 'git commit + pull + push the vault now'],
    ['stats', 'memory_recall', 'context-in recall: /stats <topic>'],
    ['help', '—', 'this list'],
    ['quit', '—', 'exit the REPL (Ctrl-C twice also works)'],
  ]
  return [
    bold('slash commands:'),
    ...rows.map(([cmd, mcp, desc]) => `  ${cyan('/' + cmd.padEnd(8))} ${dim('→ ' + mcp.padEnd(14))} ${desc}`),
    '',
    dim('bare text runs a search, same as /search'),
  ].join('\n')
}

function historyPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'omem', 'history')
}

function loadHistory(): string[] {
  const p = historyPath()
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function appendHistory(line: string): void {
  const p = historyPath()
  try {
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, line + '\n')
  } catch {
    // history is best-effort; never block the REPL on it
  }
}

function welcomeBanner(db: DB, vault: string): string {
  const s = vaultStatus(db)
  const pending = s.chunks - s.embedded
  const lines = [
    `${bold(cyan('omem'))} ${dim('— vault memory REPL')}  ${dim(vault)}`,
    `${green(String(s.notes))} notes · ${cyan(String(s.chunks))} chunks · ${
      pending ? yellow(String(pending) + ' pending') : green('all embedded')
    }${s.pinned ? ` · ${magenta(String(s.pinned) + ' pinned')}` : ''}`,
    dim('type a query, /help for commands, /quit to exit'),
  ]
  return lines.join('\n')
}

function renderResults(results: SearchResult[]): string {
  if (!results.length) return dim('no results')
  const tint: Record<string, (s: string) => string> = {
    both: magenta,
    vector: cyan,
    keyword: yellow,
    graph: green,
  }
  return results
    .map(r => {
      const loc = r.heading ? `${r.notePath} § ${r.heading}` : r.notePath
      const scoreBar = bar(r.score)
      const mt = tint[r.matchType] ?? dim
      const text = r.text.length > 280 ? r.text.slice(0, 280) + '…' : r.text
      return `\n${mt(`● ${r.score.toFixed(3)} ${r.matchType}`)} ${scoreBar} ${bold(r.title)}  ${dim(loc)}\n${text}`
    })
    .join('\n')
}

export async function startRepl(db: DB, vault: string, embedder: Embedder): Promise<void> {
  if (!process.stdin.isTTY) {
    // piped/scripted input: drive the loop but don't decorate (no prompt, no history)
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    for await (const line of rl) {
      const out = await handleLine(line, db, vault, embedder)
      if (out === '__QUIT__') break
      if (out !== null) console.error(out)
    }
    return
  }

  console.error(welcomeBanner(db, vault))
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const history = loadHistory()
  // readline doesn't expose setHistory on the promises interface; we manage our own
  let sigints = 0
  rl.on('SIGINT', () => {
    sigints++
    if (sigints >= 2) {
      console.error(dim('\nbye'))
      rl.close()
      process.exit(0)
    }
    console.error(dim("  (Ctrl-C again to quit, or type /quit)"))
    rl.prompt()
  })

  for (;;) {
    rl.setPrompt(`${bold(cyan('omem'))} ${dim('›')} `)
    const line = await new Promise<string>(res => {
      rl.once('line', res)
      rl.once('close', () => res(''))
    })
    if (line === '' && !rl.line) {
      // EOF (Ctrl-D)
      console.error(dim('\nbye'))
      break
    }
    sigints = 0
    if (!line.trim()) {
      rl.prompt()
      continue
    }
    appendHistory(line.trim())
    const out = await handleLine(line, db, vault, embedder)
    if (out === '__QUIT__') {
      break
    }
    if (out !== null) console.error(out)
    rl.prompt()
  }
  rl.close()
}

async function handleLine(
  line: string,
  db: DB,
  vault: string,
  embedder: Embedder,
): Promise<string | null> {
  const { cmd, args } = parseSlash(line)
  // bare text → search
  if (!cmd) {
    const q = args.join(' ').trim()
    if (!q) return null
    return await runSearch(db, q, embedder)
  }
  switch (cmd) {
    case 'search':
      return await runSearch(db, args.join(' ').trim(), embedder)
    case 'recent': {
      const limit = args[0] ? Math.max(1, parseInt(args[0], 10) || 5) : 5
      const s = vaultStatus(db)
      const lines = s.recent.slice(0, limit).map(
        (r, i) => `  ${dim(String(i + 1).padStart(2))} ${bold(r.title)} ${dim(r.path)}`,
      )
      return lines.length ? `${bold('recent notes:')}\n${lines.join('\n')}` : dim('no notes yet')
    }
    case 'status': {
      const s = vaultStatus(db)
      const pending = s.chunks - s.embedded
      return [
        `${bold('vault status')}`,
        `  notes: ${green(String(s.notes))} · chunks: ${cyan(String(s.chunks))} · embedded: ${
          pending ? yellow(`${s.embedded} (${pending} pending)`) : green(String(s.embedded))
        }`,
        s.pinned ? `  pinned: ${magenta(String(s.pinned))}` : '',
        s.topFolders.length
          ? `  folders: ${s.topFolders.map(f => `${f.folder || '(root)'} (${f.count})`).join(', ')}`
          : '',
        s.topKinds.length
          ? `  kinds: ${s.topKinds.map(k => `${k.kind} (${k.count})`).join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    }
    case 'write':
      return dim(
        'writing from the REPL is not wired yet — use the MCP memory_write tool or your editor + omem watch.',
      )
    case 'sync': {
      try {
        const { createGitSync } = await import('./git.ts')
        const sp = spin('git sync')
        const r = await createGitSync(vault)({ pull: true })
        sp.done()
        if (r.skipped) return dim(`skipped: ${r.skipped}`)
        const msg = `committed ${r.committed}, pulled: ${r.pulled}, pushed ${r.pushed}`
        return r.ok ? `✓ ${msg}` : `✗ ${msg} — with errors`
      } catch (e) {
        return `✗ sync failed: ${(e as Error).message}`
      }
    }
    case 'stats': {
      const q = args.join(' ').trim()
      if (!q) {
        // bare /stats → vault stats summary
        const s = vaultStatus(db)
        const pending = s.chunks - s.embedded
        const edges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE type = 'wikilink'").get() as { c: number }).c
        return `${bold('stats:')} ${s.notes} notes · ${s.chunks} chunks · ${
          pending ? yellow(String(pending) + ' pending') : green('all embedded')
        } · ${edges} edges`
      }
      return await runSearch(db, q, embedder)
    }
    case 'help':
      return helpText()
    case 'quit':
    case 'exit':
      return '__QUIT__'
    default:
      return red(`unknown command: /${cmd}`) + dim(' — /help for the list')
  }
}

async function runSearch(db: DB, query: string, embedder: Embedder): Promise<string | null> {
  if (!query) return null
  const sp = spin(`searching "${query}"`)
  try {
    const results = await search(db, query, { embedder, limit: 10 })
    sp.done()
    return renderResults(results)
  } catch (e) {
    sp.done()
    return `✗ search failed: ${(e as Error).message}`
  }
}
