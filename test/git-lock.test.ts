import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireGitLease, acquireSqliteGitLease } from '../src/git-lock.ts'

for (const backend of ['native', 'sqlite']) {
  test(`${backend} lease blocks another process and releases after SIGKILL`, { timeout: 15_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'omem-lease-'))
    const lock = join(root, 'sync.lock')
    const functionName = backend === 'sqlite' ? 'acquireSqliteGitLease' : 'acquireGitLease'
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { ${functionName} } from ${JSON.stringify(new URL('../src/git-lock.ts', import.meta.url).href)};
      const release = await ${functionName}(process.argv[1]);
      if (!release) throw new Error('unexpected contention');
      process.stdout.write('acquired');
      process.stdin.resume();
    `, lock], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => { throw new Error(`holder exited: ${stderr}`) }),
      ])
      const acquire = backend === 'sqlite' ? acquireSqliteGitLease : acquireGitLease
      assert.equal(await acquire(lock), null)
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      // On Linux the flock helper owns the lease and receives EOF when its parent dies.
      let release = await acquire(lock)
      for (let attempt = 0; !release && attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        release = await acquire(lock)
      }
      assert.ok(release, 'a killed process must not leave a stale lease')
      await release()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('SQLite lease reports backend failures instead of contention', () => {
  const root = mkdtempSync(join(tmpdir(), 'omem-lease-'))
  try {
    const lock = join(root, 'sync.lock')
    mkdirSync(`${lock}.sqlite`)
    assert.throws(() => acquireSqliteGitLease(lock), /open|database/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing Linux flock is reported as a startup error', { skip: process.platform !== 'linux', timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireGitLease } from ${JSON.stringify(new URL('../src/git-lock.ts', import.meta.url).href)};
    try {
      await acquireGitLease('/unused/omem-sync.lock');
      process.exitCode = 1;
    } catch (error) {
      process.stdout.write(error.message);
    }
  `], { env: { ...process.env, PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
  assert.match(stdout, /flock.*ENOENT/)
})
