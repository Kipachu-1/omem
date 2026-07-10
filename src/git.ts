import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const run = promisify(execFile)

// no prompt may ever hang the daemon: fail fast, retry next cycle
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
}

const LOCAL_MS = 15_000
const NET_MS = 60_000
const STALE_LOCK_MS = 600_000

/**
 * Default: whatever the machine's git is configured with (keychain, gh, store).
 * If a PAT is passed via OMEM_GIT_TOKEN / GITHUB_TOKEN / GH_TOKEN, it wins:
 * the first -c resets git's helper list so the keychain can't answer first,
 * and the inline helper reads the token from env (never from argv — ps-safe).
 */
export function tokenCredArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const token = env.OMEM_GIT_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN
  if (!token) return []
  return [
    '-c', 'credential.helper=',
    '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$OMEM_GIT_TOKEN"; }; f',
  ]
}

export interface GitSyncResult {
  ok: boolean
  committed: number
  pushed: number
  pulled: boolean
  skipped?: string
}

export interface GitSyncOpts {
  pull?: boolean
}

/** Per-vault sync function with once-per-process state (warnings, hygiene). */
export function createGitSync(vault: string, onPulled?: () => void | Promise<void>) {
  const warned = new Set<string>()
  let hygieneDone = false
  let lastConflictSha = ''

  const token = process.env.OMEM_GIT_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const env = token ? { ...ENV, OMEM_GIT_TOKEN: token } : ENV
  const cred = tokenCredArgs(process.env)

  const warnOnce = (key: string, msg: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    console.error(msg)
  }

  const git = (args: string[], timeout = LOCAL_MS) =>
    run('git', args, { cwd: vault, env, timeout, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 })

  const tryGit = async (args: string[], timeout?: number) => {
    try {
      return await git(args, timeout)
    } catch {
      return null
    }
  }

  const hasGitProcess = async (): Promise<boolean> => {
    try {
      const { stdout } = await run('ps', ['-eo', 'comm='], { timeout: LOCAL_MS })
      return stdout.split('\n').some(command => command.trim() === 'git')
    } catch {
      return true // unable to inspect processes: preserve the lock
    }
  }

  const firstLine = (e: unknown): string =>
    String((e as { stderr?: string }).stderr ?? (e as Error).message ?? e).trim().split('\n')[0]

  const head = async (): Promise<string> => (await tryGit(['rev-parse', '-q', '--verify', 'HEAD']))?.stdout.trim() ?? ''

  // commit AND pull --rebase both create commits; a headless box with no git
  // identity must not wedge either (rebase dies with "Committer identity unknown")
  const identity = async (): Promise<string[]> =>
    (await tryGit(['config', 'user.email']))?.stdout.trim() ? [] : ['-c', 'user.name=omem', '-c', 'user.email=omem@localhost']

  /** 'ok' = clean (possibly no-op) pull; 'conflict' = aborted, warned; 'fail' = network/other, warned */
  async function pullRebase(): Promise<'ok' | 'conflict' | 'fail'> {
    const before = await head()
    try {
      // -X theirs in a rebase keeps the LOCAL commit's hunks; the remote version stays in ancestry
      await git([...cred, ...(await identity()), 'pull', '--rebase=true', '-X', 'theirs', '--no-autostash', '-q'], NET_MS)
      if ((await head()) !== before && onPulled) await onPulled()
      return 'ok'
    } catch (e) {
      const midRebase = existsSync(await gitPath('rebase-merge')) || existsSync(await gitPath('rebase-apply'))
      if (midRebase) {
        ;(await tryGit(['rebase', '--abort'])) ?? (await tryGit(['rebase', '--quit']))
        const remote = (await tryGit(['rev-parse', '-q', '--verify', '@{u}']))?.stdout.trim() ?? ''
        if (remote !== lastConflictSha) {
          lastConflictSha = remote
          console.error(`omem git: pull hit an unresolvable conflict (${firstLine(e)}) — sync paused for this remote state, resolve manually in the vault`)
        }
        return 'conflict'
      }
      console.error(`omem git: pull failed (${firstLine(e)}) — retrying next cycle`)
      return 'fail'
    }
  }

  const gitPath = async (p: string): Promise<string> => {
    const out = (await git(['rev-parse', '--git-path', p])).stdout.trim()
    return resolve(vault, out)
  }

  /** preflight: repo exists, not detached, no stale lock, recover interrupted rebase. Returns skip reason or null. */
  async function preflight(): Promise<string | null> {
    if (!(await tryGit(['rev-parse', '--is-inside-work-tree']))) {
      warnOnce('norepo', `omem git: ${vault} is not a git repository — sync disabled`)
      return 'not a repo'
    }
    if (!(await tryGit(['symbolic-ref', '--short', '-q', 'HEAD']))) {
      warnOnce('detached', 'omem git: detached HEAD — sync disabled until a branch is checked out')
      return 'detached HEAD'
    }
    const lock = await gitPath('index.lock')
    if (existsSync(lock)) {
      const age = Date.now() - statSync(lock).mtimeMs
      if (age > STALE_LOCK_MS) {
        // Git write commands own index.lock; preserve it when any Git process is active.
        if (!(await hasGitProcess())) {
          rmSync(lock, { force: true })
          console.error(`omem git: removed stale index.lock (${Math.round(age / 60_000)} min old)`)
          return null
        }
      }
      return 'index.lock held' // another git process; git's own locking keeps things safe
    }
    if (existsSync(await gitPath('rebase-merge')) || existsSync(await gitPath('rebase-apply'))) {
      console.error('omem git: recovering from an interrupted rebase')
      ;(await tryGit(['rebase', '--abort'])) ?? (await tryGit(['rebase', '--quit']))
    }
    return null
  }

  /** once per process: ignore hygiene + untrack the derived index. */
  async function hygiene(): Promise<void> {
    if (hygieneDone) return
    hygieneDone = true
    const gi = resolve(vault, '.gitignore')
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
    if (!cur.includes('# omem')) {
      appendFileSync(gi, `${cur && !cur.endsWith('\n') ? '\n' : ''}# omem\n.omem/\n.DS_Store\n.obsidian/workspace*\n`)
    }
    if ((await tryGit(['ls-files', '--', '.omem']))?.stdout.trim()) {
      await tryGit(['rm', '-r', '--cached', '-q', '--', '.omem'])
      console.error('omem git: untracked .omem/ (the index is derived; it does not belong in the repo)')
    }
  }

  /** commit staged changes (pathspec mandatory: bare -A stages the whole repo when vault is nested). */
  async function commitPhase(res: GitSyncResult): Promise<void> {
    // pathspec is mandatory: bare -A stages the whole repo when the vault is nested in one
    await git(['add', '-A', '--', '.'])
    if ((await tryGit(['diff', '--cached', '--quiet', '--', '.'])) === null) {
      const names = (await git(['diff', '--cached', '--name-only', '--', '.'])).stdout.trim().split('\n').filter(Boolean)
      const body = names.slice(0, 3).join('\n') + (names.length > 3 ? `\n… ${names.length - 3} more` : '')
      await git(['-c', 'commit.gpgsign=false', ...(await identity()), 'commit', '-q', '--no-verify', '-m', `omem: sync ${names.length} note(s)`, '-m', body])
      res.committed = names.length
      console.error(`omem git: committed ${names.length} file(s)`)
    }
  }

  /** pull --rebase; returns false on conflict/fail (caller sets res.ok). */
  async function pullPhase(res: GitSyncResult, opts: GitSyncOpts): Promise<boolean> {
    if (opts.pull === false) return true
    const p = await pullRebase()
    if (p === 'conflict' || p === 'fail') return ((res.ok = false), false)
    res.pulled = true
    return true
  }

  /** push with non-fast-forward retry (integrate once, then retry). */
  async function pushPhase(res: GitSyncResult): Promise<void> {
    const ahead = Number((await git(['rev-list', '--count', '@{u}..HEAD'])).stdout.trim())
    if (ahead <= 0) return
    try {
      await git([...cred, 'push', '-q'], NET_MS)
      res.pushed = ahead
      console.error(`omem git: pushed ${ahead} commit(s)`)
    } catch (e) {
      // non-fast-forward: someone pushed concurrently — integrate once and retry
      if ((await pullRebase()) === 'ok') {
        try {
          await git([...cred, 'push', '-q'], NET_MS)
          res.pushed = Number((await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'])).stdout.trim()) || 1
          console.error('omem git: pushed after integrating a concurrent update')
          return
        } catch (e2) {
          console.error(`omem git: push failed (${firstLine(e2)}) — retrying next cycle`)
        }
      } else {
        console.error(`omem git: push failed (${firstLine(e)}) — retrying next cycle`)
      }
      res.ok = false
    }
  }

  return async function gitSync(opts: GitSyncOpts = {}): Promise<GitSyncResult> {
    const res: GitSyncResult = { ok: true, committed: 0, pushed: 0, pulled: false }
    const skip = (why: string): GitSyncResult => ((res.skipped = why), res)

    // --- preflight
    const skipReason = await preflight()
    if (skipReason) return skip(skipReason)

    // --- once per process: ignore hygiene + untrack the derived index
    await hygiene()

    // --- commit
    await commitPhase(res)

    // --- unborn branch / no upstream: local commits are still the backup
    if (!(await head())) {
      warnOnce('unborn', 'omem git: branch has no commits yet — running in commit-only mode')
      return res
    }
    if (!(await tryGit(['rev-parse', '-q', '--verify', '@{u}']))) {
      warnOnce('noupstream', 'omem git: no upstream configured — commit-only mode (run `git push -u origin <branch>` in the vault to enable push)')
      return res
    }

    // --- pull
    if (!(await pullPhase(res, opts))) return res

    // --- push
    await pushPhase(res)

    return res
  }
}
