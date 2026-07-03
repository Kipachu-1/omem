import { createInterface } from 'node:readline/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readConfigFile, writeConfigFile, type OmemConfig } from './config.ts'
import { bold, dim, cyan, ok, warn, spin } from './ui.ts'

const run = promisify(execFile)
const expand = (p: string): string => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p)

export async function runSetup(): Promise<void> {
  // OMEM_SETUP_STDIN=1 lets tests drive the wizard through a pipe
  if (!process.stdin.isTTY && process.env.OMEM_SETUP_STDIN !== '1') {
    console.error('omem setup is interactive — run it in a terminal, or configure via env/flags (see .env.example)')
    process.exit(1)
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  rl.on('SIGINT', () => {
    console.error('\nsetup aborted — nothing written')
    process.exit(130)
  })
  // manual line queue instead of rl.question: piped input delivers lines before
  // questions are asked (rl.question would drop them, then throw on EOF);
  // EOF while questions remain -> '' -> defaults apply
  const lines: string[] = []
  const waiters: ((s: string) => void)[] = []
  let closed = false
  rl.on('line', l => {
    const w = waiters.shift()
    if (w) w(l)
    else lines.push(l)
  })
  rl.on('close', () => {
    closed = true
    while (waiters.length) waiters.shift()!('')
  })
  const nextLine = (): Promise<string> =>
    lines.length ? Promise.resolve(lines.shift()!) : closed ? Promise.resolve('') : new Promise(r => waiters.push(r))
  const ask = async (q: string, def = ''): Promise<string> => {
    process.stderr.write(`${bold(q)}${def ? dim(` [${def}]`) : ''}: `)
    return (await nextLine()).trim() || def
  }
  const askInt = async (q: string, def: number): Promise<number> => {
    for (;;) {
      const n = Number(await ask(q, String(def)))
      if (Number.isInteger(n) && n >= 1) return n
      console.error('  enter a positive integer')
    }
  }
  const yes = async (q: string, def = true): Promise<boolean> => {
    const a = (await ask(`${q} [${def ? 'Y/n' : 'y/N'}]`)).toLowerCase()
    return a === '' ? def : a === 'y' || a === 'yes'
  }

  const prev = readConfigFile()
  console.error(`${bold(cyan('omem setup'))} ${dim('— Enter accepts the [default]')}\n`)

  let vault: string
  for (;;) {
    const answer = await ask('vault path (your Obsidian folder)', prev.vault ?? '')
    vault = resolve(expand(answer))
    if (answer && existsSync(vault)) break
    console.error(`  not found: ${vault}`)
    if (closed) {
      console.error('no valid vault provided — aborting')
      process.exit(1)
    }
  }

  const remote = await run('git', ['-C', vault, 'remote', 'get-url', 'origin'])
    .then(r => r.stdout.trim())
    .catch(() => null)
  const isRepo =
    remote !== null ||
    (await run('git', ['-C', vault, 'rev-parse', '--is-inside-work-tree']).then(() => true).catch(() => false))

  let git = false
  let gitPullInterval: number | undefined
  let githubToken: string | undefined
  if (remote) {
    git = await yes(`git auto-commit + push? (remote: ${remote})`)
    if (git) {
      gitPullInterval = await askInt('pull remote changes every N seconds', prev.gitPullInterval ?? 300)
      githubToken =
        (await ask('GitHub PAT — Enter to use machine git credentials (recommended; input is visible)')) || undefined
    }
  } else if (isRepo) {
    git = await yes('vault is a git repo with no remote — enable commit-only git sync?', false)
  } else {
    console.error('  vault is not a git repo — skipping git sync (git init later and re-run setup)')
  }

  const poll = await askInt('index sweep interval, seconds', prev.poll ?? 30)

  const cfg: OmemConfig = {
    vault,
    poll,
    ...(git ? { git: true } : {}),
    ...(gitPullInterval ? { gitPullInterval } : {}),
    ...(githubToken ? { githubToken } : {}),
    ...(prev.embedModel ? { embedModel: prev.embedModel } : {}),
    ...(prev.dbPath ? { dbPath: prev.dbPath } : {}),
  }
  const path = writeConfigFile(cfg)
  console.error('')
  ok(`saved ${path}${githubToken ? dim(' (contains your token — file mode 600)') : ''}`)
  console.error('')

  if (await yes('index the vault now? (first run downloads a ~30MB embedding model)')) {
    const { openDb } = await import('./db.ts')
    const { fullIndex, embedPending } = await import('./indexer.ts')
    const { localEmbedder } = await import('./embed.ts')
    const db = openDb(cfg.dbPath ? expand(cfg.dbPath) : join(vault, '.omem', 'index.db'))
    const sp = spin('indexing')
    const s = fullIndex(db, vault)
    sp.done()
    ok(`indexed ${s.indexed}, removed ${s.removed}, unchanged ${s.unchanged}`)
    const spe = spin('embedding (first run downloads the model)')
    try {
      const n = await embedPending(db, localEmbedder(cfg.embedModel))
      spe.done()
      if (n) ok(`embedded ${n} chunks`)
    } catch (e) {
      spe.done()
      warn(`embedding failed (${(e as Error).message}) — keyword-only until the next index run`)
    }
    db.close()
  }

  const { offerAgents } = await import('./agents.ts')
  await offerAgents(q => yes(q, false))

  console.error(`\n${bold('done.')} next:
  ${cyan('omem watch')}                    ${dim('# keep the vault indexed + git-synced in a terminal')}
  ${cyan('omem search')} "what do I know about X"
  ${cyan('omem stats')}`)
  rl.close()
}
