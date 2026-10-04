import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { readBundle, writeBundle, skillDetailsSchema } from '../src/skills/bundle.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
let root: string
let vault: string
let home: string
let stateDir: string
let source: string
let env: NodeJS.ProcessEnv
const raw = '---\nname: cli-review\ndescription: Review code changes\n---\n# Review\nRead references/checklist.md.\n'
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'omem-skills-cli-')))
  vault = join(root, 'vault'); home = join(root, 'home'); stateDir = join(root, 'state')
  source = join(root, 'imports', 'cli-review')
  for (const dir of [vault, home, join(source, 'references'), join(source, 'scripts')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), raw)
  writeFileSync(join(source, 'references', 'checklist.md'), 'Check observed behavior.')
  writeFileSync(join(source, 'scripts', 'check.sh'), '#!/bin/sh\nprintf "native-checked\\n"\n', { mode: 0o755 })
  env = { ...process.env, XDG_CONFIG_HOME: join(root, 'xdg'), OMEM_ENV_FILE: '/nonexistent' }
  for (const key of Object.keys(env)) if ((key.startsWith('OMEM_') && key !== 'OMEM_ENV_FILE') || key === 'GITHUB_TOKEN' || key === 'GH_TOKEN') delete env[key]
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function run(args: string[], extra: NodeJS.ProcessEnv = {}): unknown {
  return JSON.parse(execFileSync(process.execPath, [CLI, 'skills', ...args, '--skills-home', home, '--skills-state-dir', stateDir], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 20000 }))
}

test('CLI imports selected complete skills and synchronizes native copies without changing originals', () => {
  const imported = skillDetailsSchema.parse(run(['import', source, '--vault', vault]))
  assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), raw)
  assert.equal(imported.manifest.length, 3)
  const listing = z.object({ skills: z.array(z.object({ name: z.string() })), total: z.number() }).parse(run(['list', '--vault', vault, '--query', 'review', '--json']))
  assert.equal(listing.skills[0]?.name, 'cli-review')
  const sync = z.object({ installed: z.array(z.string()) }).parse(run(['sync', '--vault', vault]))
  assert.deepEqual(sync.installed, ['cli-review'])
  const native = join(home, '.agents', 'skills', 'cli-review')
  assert.equal(readFileSync(join(native, 'references/checklist.md'), 'utf8'), 'Check observed behavior.')
  assert.equal(execFileSync(join(native, 'scripts/check.sh'), { encoding: 'utf8' }), 'native-checked\n')
  assert.equal(z.object({ installed: z.array(z.object({ name: z.string() })) }).parse(run(['status'])).installed[0]?.name, 'cli-review')
  assert.deepEqual(z.object({ unchanged: z.array(z.string()) }).parse(run(['sync', '--vault', vault])).unchanged, ['cli-review'])
})

test('CLI stats automatically reconciles old indexed skill notes without a rebuild', () => {
  run(['list', '--vault', vault])
  const db = new Database(join(vault, '.omem', 'index.db'))
  db.prepare('INSERT INTO notes(path,title,mtime,hash) VALUES (?,?,?,?)').run('skills/legacy/SKILL.md', 'Old skill', 0, 'legacy-hash')
  db.close()
  const result = execFileSync(process.execPath, [CLI, 'stats', '--vault', vault], { encoding: 'utf8', env })
  assert.match(result, /notes\s+0/)
  const check = new Database(join(vault, '.omem', 'index.db'), { readonly: true })
  try { assert.deepEqual(check.prepare('SELECT path FROM notes').all(), []) }
  finally { check.close() }
})

test('CLI requires an explicit revision to replace an imported skill and never silently renames invalid imports', () => {
  const first = skillDetailsSchema.parse(run(['import', source, '--vault', vault]))
  writeFileSync(join(source, 'references/checklist.md'), 'Second revision.')
  const conflict = spawnSync(process.execPath, [CLI, 'skills', 'import', source, '--vault', vault], { encoding: 'utf8', env })
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /revision conflict/)
  const updated = skillDetailsSchema.parse(run(['import', source, '--vault', vault, '--expected-revision', first.revision]))
  assert.notEqual(updated.revision, first.revision)
  writeFileSync(join(source, 'SKILL.md'), raw.replace('name: cli-review', 'name: Wrong Name'))
  const invalid = spawnSync(process.execPath, [CLI, 'skills', 'import', source, '--vault', vault], { encoding: 'utf8', env })
  assert.equal(invalid.status, 1)
  assert.equal(readFileSync(join(vault, 'skills/cli-review/SKILL.md'), 'utf8'), raw)
})

test('CLI reports local conflicts with an unsuccessful exit and supports explicit adoption', () => {
  run(['import', source, '--vault', vault])
  const target = join(home, '.agents/skills/cli-review')
  mkdirSync(join(target, 'references'), { recursive: true }); mkdirSync(join(target, 'scripts'), { recursive: true })
  for (const file of ['SKILL.md', 'references/checklist.md', 'scripts/check.sh']) writeFileSync(join(target, file), readFileSync(join(source, file)), { mode: file.endsWith('.sh') ? 0o755 : 0o644 })
  const args = [CLI, 'skills', 'sync', '--vault', vault, '--skills-home', home, '--skills-state-dir', stateDir]
  const blocked = spawnSync(process.execPath, args, { encoding: 'utf8', env })
  assert.equal(blocked.status, 1)
  assert.equal(z.object({ conflicts: z.array(z.unknown()) }).parse(JSON.parse(blocked.stdout)).conflicts.length, 1)
  assert.equal(z.object({ installed: z.array(z.string()) }).parse(run(['sync', '--vault', vault, '--adopt'])).installed[0], 'cli-review')
})

test('CLI uses saved server config and explicit local vault overrides it', () => {
  mkdirSync(join(root, 'xdg', 'omem'), { recursive: true })
  writeFileSync(join(root, 'xdg', 'omem', 'config.json'), JSON.stringify({ skillsServer: 'http://127.0.0.1:1/mcp' }))
  const result = run(['list', '--vault', vault])
  assert.equal(z.object({ total: z.number() }).parse(result).total, 0)
  assert.ok(!existsSync(join(home, '.agents')))
})

test('watch profile selects its source, starts sync immediately, and exits on SIGTERM', async () => {
  run(['import', source, '--vault', vault])
  const config = join(root, 'watch.json')
  writeFileSync(config, JSON.stringify({ source: { kind: 'local', vault }, claude: true, interval: 1 }), { mode: 0o600 })
  const child = spawn(process.execPath, [CLI, 'skills', 'watch', '--skills-config', config, '--skills-home', home, '--skills-state-dir', stateDir, '--json'], { env: { ...env, OMEM_SKILLS_SERVER: 'http://127.0.0.1:1/mcp' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; let errors = ''
  child.stderr.on('data', data => { errors += String(data) })
  const exit = new Promise<number | null>(resolveExit => child.once('exit', resolveExit))
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Watch did not sync: ${errors}`)), 10000)
      child.stdout.on('data', data => {
        output += String(data)
        if (output.includes('"cli-review"')) { clearTimeout(timeout); resolveReady() }
      })
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Watch exited ${code}: ${errors}`)) })
    })
    assert.equal(readFileSync(join(home, '.claude/skills/cli-review/references/checklist.md'), 'utf8'), 'Check observed behavior.')
    child.kill('SIGTERM')
    assert.equal(await exit, 0)
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exit } }
})

test('offline CLI sync recovers an interrupted install before reporting a connection failure', () => {
  run(['import', source, '--vault', vault])
  run(['sync', '--vault', vault])
  const target = join(home, '.agents/skills/cli-review')
  const backup = join(home, '.agents/skills/.omem-backup-cli-review-offline')
  const stage = join(home, '.agents/skills/.omem-stage-offline')
  const bundle = readBundle(source)
  writeBundle(stage, bundle.files)
  renameSync(target, backup)
  const db = new Database(join(stateDir, 'skills-sync.db'))
  db.prepare('INSERT INTO sync_meta(key,value) VALUES (?,?)').run('journal', JSON.stringify({ home, operations: [{ target, stage, backup, existed: true, fingerprint: `bundle:${bundle.revision}` }] }))
  db.close()
  const result = spawnSync(process.execPath, [CLI, 'skills', 'sync', '--server', 'http://127.0.0.1:1/mcp', '--skills-home', home, '--skills-state-dir', stateDir], { encoding: 'utf8', env: { ...env, OMEM_SKILLS_TOKEN: 'private-test-token' } })
  assert.equal(result.status, 1)
  assert.equal(result.stderr.includes('private-test-token'), false)
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), raw)
  assert.equal(existsSync(backup), false)
  assert.equal(existsSync(stage), false)
})

test('agents registration status remains available when optional native skill state is corrupt', () => {
  const configDir = join(root, 'xdg', 'omem')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'skills-sync.db'), 'not a SQLite database')
  const result = JSON.parse(execFileSync(process.execPath, [CLI, 'agents', '--json'], { encoding: 'utf8', env: { ...env, HOME: home } }))
  const statuses = z.array(z.object({ name: z.string(), state: z.enum(['missing', 'registered', 'unknown']), skills: z.object({ mode: z.enum(['native', 'mcp']), error: z.string().optional() }) })).parse(result)
  assert.equal(statuses.find(agent => agent.name === 'Codex CLI')?.state, 'missing')
  assert.match(statuses.find(agent => agent.name === 'Codex CLI')?.skills.error ?? '', /not a database/)
  assert.deepEqual(statuses.find(agent => agent.name === 'Claude Desktop')?.skills, { mode: 'mcp' })
})

test('watch keeps retrying when connection failures coincide with unreadable sync state', async () => {
  mkdirSync(stateDir)
  writeFileSync(join(stateDir, 'skills-sync.db'), 'not a SQLite database')
  const child = spawn(process.execPath, [CLI, 'skills', 'watch', '--server', 'http://127.0.0.1:1/mcp', '--interval', '1', '--skills-home', home, '--skills-state-dir', stateDir], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exit = new Promise<number | null>(resolveExit => child.once('exit', resolveExit))
  let errors = ''
  try {
    await new Promise<void>((resolveRetried, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Watch did not retry: ${errors}`)), 10000)
      child.stderr.on('data', data => {
        errors += String(data)
        if ((errors.match(/skills sync failed:/g) ?? []).length >= 2) { clearTimeout(timeout); resolveRetried() }
      })
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Watch exited ${code}: ${errors}`)) })
    })
    assert.match(errors, /skills recovery failed:/)
    child.kill('SIGTERM')
    assert.equal(await exit, 0)
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exit } }
})
