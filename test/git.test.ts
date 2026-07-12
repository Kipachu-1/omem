import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitSync } from '../src/git.ts'

const g = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim()

let root: string
let origin: string
let vaultA: string

const initRepo = (dir: string): void => {
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.name', 'tester')
  g(dir, 'config', 'user.email', 'tester@example.com')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omem-git-'))
  origin = join(root, 'origin.git')
  mkdirSync(origin)
  g(origin, 'init', '-q', '--bare', '-b', 'main')
  vaultA = join(root, 'vaultA')
  mkdirSync(vaultA)
  initRepo(vaultA)
  writeFileSync(join(vaultA, 'seed.md'), 'seed note\n')
  g(vaultA, 'add', '-A')
  g(vaultA, 'commit', '-q', '-m', 'seed')
  g(vaultA, 'remote', 'add', 'origin', origin)
  g(vaultA, 'push', '-q', '-u', 'origin', 'main')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const cloneB = (): string => {
  const b = join(root, 'vaultB')
  g(root, 'clone', '-q', origin, b)
  g(b, 'config', 'user.name', 'other')
  g(b, 'config', 'user.email', 'other@example.com')
  return b
}

test('dirty vault: commits, pushes, adds ignore block', async () => {
  writeFileSync(join(vaultA, 'note.md'), 'a new memory\n')
  const r = await createGitSync(vaultA)({ pull: true })
  assert.equal(r.ok, true)
  assert.ok(r.committed >= 1)
  assert.equal(r.pushed, 1)
  assert.equal(g(vaultA, 'status', '--porcelain'), '')
  assert.match(g(origin, 'log', '-1', '--format=%s'), /omem: sync \d+ note/)
  assert.match(readFileSync(join(vaultA, '.gitignore'), 'utf8'), /\.omem\//)
})

test('successful sync writes .omem/last_sync timestamp', async () => {
  const before = Date.now()
  await createGitSync(vaultA)({ pull: true })
  const f = join(vaultA, '.omem', 'last_sync')
  assert.ok(existsSync(f), '.omem/last_sync should exist after a successful sync')
  const ts = parseInt(readFileSync(f, 'utf8'), 10)
  assert.ok(ts >= before, `last_sync timestamp (${ts}) should be >= sync start (${before})`)
  assert.ok(ts <= Date.now(), `last_sync timestamp (${ts}) should be <= now (${Date.now()})`)
})

test('clean vault: no commit, no push, no error', async () => {
  const before = g(origin, 'rev-parse', 'main')
  const sync = createGitSync(vaultA)
  await sync({ pull: true }) // first run commits the .gitignore hygiene
  const r = await sync({ pull: true })
  assert.equal(r.committed, 0)
  assert.equal(r.pushed, 0)
  assert.equal(r.ok, true)
  assert.notEqual(g(origin, 'rev-parse', 'main'), before) // hygiene commit only
})

test('tracked .omem gets untracked but stays on disk', async () => {
  mkdirSync(join(vaultA, '.omem'))
  writeFileSync(join(vaultA, '.omem/index.db'), 'binary-ish')
  g(vaultA, 'add', '-A')
  g(vaultA, 'commit', '-q', '-m', 'oops committed the index')
  const r = await createGitSync(vaultA)({ pull: true })
  assert.equal(r.ok, true)
  assert.equal(g(vaultA, 'ls-files', '--', '.omem'), '', '.omem must be untracked')
  assert.ok(existsSync(join(vaultA, '.omem/index.db')), 'file must remain on disk')
})

test('pull brings remote notes in', async () => {
  const b = cloneB()
  writeFileSync(join(b, 'from-b.md'), 'written on machine B\n')
  g(b, 'add', '-A')
  g(b, 'commit', '-q', '-m', 'note from B')
  g(b, 'push', '-q')
  const r = await createGitSync(vaultA)({ pull: true })
  assert.equal(r.ok, true)
  assert.ok(existsSync(join(vaultA, 'from-b.md')))
})

test('onPulled fires only when HEAD moved', async () => {
  let calls = 0
  const sync = createGitSync(vaultA, () => void calls++)
  await sync({ pull: true })
  const after1 = calls
  const b = cloneB()
  writeFileSync(join(b, 'newer.md'), 'x\n')
  g(b, 'add', '-A')
  g(b, 'commit', '-q', '-m', 'x')
  g(b, 'push', '-q')
  await sync({ pull: true })
  assert.equal(calls, after1 + 1)
  await sync({ pull: true }) // nothing new
  assert.equal(calls, after1 + 1)
})

test('conflicting edits: local wins via -X theirs, remote version stays in ancestry, no wedge', async () => {
  const b = cloneB()
  writeFileSync(join(b, 'seed.md'), 'remote edit\n')
  g(b, 'add', '-A')
  g(b, 'commit', '-q', '-m', 'remote change to seed')
  g(b, 'push', '-q')

  writeFileSync(join(vaultA, 'seed.md'), 'local edit\n')
  const r = await createGitSync(vaultA)({ pull: true })
  assert.equal(r.ok, true, 'conflict must not wedge the sync')
  assert.equal(readFileSync(join(vaultA, 'seed.md'), 'utf8'), 'local edit\n', 'local edit wins')
  assert.ok(r.pushed >= 1)
  assert.match(g(vaultA, 'log', '--format=%s'), /remote change to seed/, 'remote commit remains in ancestry')
  assert.ok(!existsSync(join(vaultA, '.git/rebase-merge')), 'no rebase state left behind')
})

test('concurrent push: rejected push integrates and retries once', async () => {
  const b = cloneB()
  writeFileSync(join(vaultA, 'mine.md'), 'A note\n')
  // B pushes between A's pull and A's push — simulate by disabling A's pull
  writeFileSync(join(b, 'theirs.md'), 'B note\n')
  g(b, 'add', '-A')
  g(b, 'commit', '-q', '-m', 'B wins the race')
  g(b, 'push', '-q')
  const r = await createGitSync(vaultA)({ pull: false })
  assert.equal(r.ok, true)
  const originFiles = g(origin, 'ls-tree', '--name-only', 'main')
  assert.ok(originFiles.includes('mine.md') && originFiles.includes('theirs.md'), 'both commits reach origin')
})

test('unborn branch: commit-only, no crash', async () => {
  const fresh = join(root, 'fresh')
  mkdirSync(fresh)
  initRepo(fresh)
  writeFileSync(join(fresh, 'first.md'), 'x\n')
  const r = await createGitSync(fresh)({ pull: true })
  assert.equal(r.ok, true)
  assert.ok(r.committed >= 1)
  assert.equal(r.pushed, 0)
  assert.match(g(fresh, 'log', '-1', '--format=%s'), /omem: sync/)
})

test('vault nested inside a bigger repo: only the vault subtree is committed', async () => {
  const outer = join(root, 'outer')
  mkdirSync(outer)
  initRepo(outer)
  writeFileSync(join(outer, 'unrelated.ts'), 'export {}\n')
  g(outer, 'add', '-A')
  g(outer, 'commit', '-q', '-m', 'outer seed')
  const nested = join(outer, 'vault')
  mkdirSync(nested)
  writeFileSync(join(nested, 'note.md'), 'nested vault note\n')
  writeFileSync(join(outer, 'outer-dirty.ts'), 'export {}\n') // dirty file OUTSIDE the vault

  const r = await createGitSync(nested)({ pull: true })
  assert.ok(r.committed >= 1)
  const committed = g(outer, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.ok(committed.every(f => f.startsWith('vault/')), `must not commit outside the vault, got: ${committed}`)
  assert.match(g(outer, 'status', '--porcelain'), /outer-dirty\.ts/, 'outer dirty file stays uncommitted')
})

test('non-repo vault: skips gracefully', async () => {
  const plain = join(root, 'plain')
  mkdirSync(plain)
  writeFileSync(join(plain, 'note.md'), 'x\n')
  const r = await createGitSync(plain)({ pull: true })
  assert.equal(r.skipped, 'not a repo')
})

test('fresh index.lock: cycle skipped, nothing breaks', async () => {
  writeFileSync(join(vaultA, '.git/index.lock'), '')
  const r = await createGitSync(vaultA)({ pull: true })
  assert.equal(r.skipped, 'index.lock held')
  rmSync(join(vaultA, '.git/index.lock'))
  const r2 = await createGitSync(vaultA)({ pull: true })
  assert.equal(r2.ok, true)
})

const staleLock = (): string => {
  const lock = join(vaultA, '.git/index.lock')
  writeFileSync(lock, '')
  const old = new Date(Date.now() - 11 * 60_000)
  utimesSync(lock, old, old)
  return lock
}

test('best-effort stale index.lock without active Git process: removes lock and syncs', async () => {
  const lock = staleLock()
  const r = await createGitSync(vaultA, undefined, { hasGitProcess: async () => false })({ pull: true })
  assert.equal(r.ok, true)
  assert.ok(!existsSync(lock), 'stale lock must be removed before sync')
})

test('stale index.lock with active Git process: keeps lock and skips', async () => {
  const lock = staleLock()
  const r = await createGitSync(vaultA, undefined, { hasGitProcess: async () => true })({ pull: true })
  assert.equal(r.skipped, 'index.lock held')
  assert.ok(existsSync(lock))
})

test('stale index.lock when process inspection fails: keeps lock and skips', async () => {
  const lock = staleLock()
  const r = await createGitSync(vaultA, undefined, { hasGitProcess: async () => { throw new Error('ps unavailable') } })({ pull: true })
  assert.equal(r.skipped, 'index.lock held')
  assert.ok(existsSync(lock))
})

test('same-vault sync is skipped while another omem sync holds its lease', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = createGitSync(vaultA, undefined, { beforeReleaseLease: () => held })({ pull: true })
  for (let i = 0; i < 40; i++) {
    const second = await createGitSync(vaultA)({ pull: true })
    if (second.skipped === 'omem sync held') {
      release()
      assert.equal((await first).ok, true)
      const third = await createGitSync(vaultA)({ pull: true })
      assert.notEqual(third.skipped, 'omem sync held', 'kernel lease must release with the holder')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  release()
  await first
  assert.fail('first sync never acquired a lease')
})

test('kernel lease is released after its holder is killed', async () => {
  const lock = join(vaultA, '.git/omem-sync.lock')
  const holder = spawn('flock', [lock, 'sh', '-c', 'cat >/dev/null'], { stdio: ['pipe', 'ignore', 'ignore'] })
  let sawHeld = false
  for (let i = 0; i < 40; i++) {
    const r = await createGitSync(vaultA)({ pull: true })
    if (r.skipped === 'omem sync held') {
      sawHeld = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(sawHeld, 'external flock holder must block omem sync')
  holder.kill('SIGKILL')
  await new Promise<void>(resolve => holder.once('exit', () => resolve()))
  const r = await createGitSync(vaultA)({ pull: true })
  assert.notEqual(r.skipped, 'omem sync held', 'killed holder must free kernel lease')
})

test('stale index.lock is preserved while another omem sync holds the vault lease', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = createGitSync(vaultA, undefined, { beforeReleaseLease: () => held })({ pull: true })
  let heldLease = false
  for (let i = 0; i < 40; i++) {
    const probe = await createGitSync(vaultA)({ pull: true })
    if (probe.skipped === 'omem sync held') {
      heldLease = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(heldLease, 'first sync must hold vault lease')
  const lock = staleLock()
  const r = await createGitSync(vaultA, undefined, { hasGitProcess: async () => false })({ pull: true })
  assert.equal(r.skipped, 'omem sync held')
  assert.ok(existsSync(lock), 'cleanup must not run without the vault lease')
  release()
  await first
})

test('convergence: interleaved writers on two clones never lose a note', async () => {
  const b = cloneB()
  const syncA = createGitSync(vaultA)
  const syncB = createGitSync(b)
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(vaultA, `a-${i}.md`), `note a${i}\n`)
    writeFileSync(join(b, `b-${i}.md`), `note b${i}\n`)
    assert.equal((await syncA({ pull: true })).ok, true)
    assert.equal((await syncB({ pull: true })).ok, true)
  }
  await syncA({ pull: true }) // pick up B's final push
  for (let i = 0; i < 4; i++) {
    assert.ok(existsSync(join(vaultA, `a-${i}.md`)) && existsSync(join(vaultA, `b-${i}.md`)), `vault A missing notes at round ${i}`)
    assert.ok(existsSync(join(b, `a-${i}.md`)) && existsSync(join(b, `b-${i}.md`)), `vault B missing notes at round ${i}`)
  }
})

test('token env wins over machine credential helpers; no token = machine default', async () => {
  const { tokenCredArgs } = await import('../src/git.ts')
  assert.deepEqual(tokenCredArgs({}), [], 'no token -> no override, machine creds apply')

  const args = tokenCredArgs({ GITHUB_TOKEN: 'test-pat-42' })
  assert.ok(args.length > 0)
  const out = execFileSync('git', [...args, 'credential', 'fill'], {
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
    env: { ...process.env, OMEM_GIT_TOKEN: 'test-pat-42', GIT_TERMINAL_PROMPT: '0' },
  })
  assert.match(out, /username=x-access-token/)
  assert.match(out, /password=test-pat-42/, 'explicit PAT must be the answering credential')
})
