import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { durable } from '../src/skills/durable.ts'
import { checkLaunch, serveCmd, offerAgents, registerCodex } from '../src/agents.ts'
import { checkDoctor } from '../src/doctor.ts'
import { createBundle, readBundle, writeBundle } from '../src/skills/bundle.ts'

test('durability handles directories and files without hiding missing-file errors', t => {
  const root = mkdtempSync(join(tmpdir(), 'omem-durable-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'data')
  writeFileSync(file, 'test')
  durable(file)
  durable(root)
  assert.throws(() => durable(join(root, 'missing')))
})

test('launch status distinguishes a configured missing executable from an absolute Node command', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omem-launch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'config.toml')
  writeFileSync(path, '[mcp_servers.omem]\ncommand = "omem-does-not-exist-87236"\n')
  assert.equal((await checkLaunch(path)).status, 'broken')
  writeFileSync(path, `[mcp_servers.omem]\ncommand = ${JSON.stringify(process.execPath)}\nargs = []\n`)
  assert.equal((await checkLaunch(path)).status, 'launchable')
  const cmd = await serveCmd()
  assert.ok(isAbsolute(cmd[0]) && isAbsolute(cmd[1]))
  const calls: string[] = []
  await offerAgents(async () => true, [{ name: 'Broken', state: () => 'registered', register: async () => { calls.push('repair'); return 'repaired' } }], true)
  assert.deepEqual(calls, ['repair'])
})

test('help works without configuration and invalid flags do not print a stack', t => {
  const root = mkdtempSync(join(tmpdir(), 'omem-help-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'omem'))
  writeFileSync(join(root, 'omem', 'config.json'), '{invalid')
  const env = { ...process.env, XDG_CONFIG_HOME: root, OMEM_ENV_FILE: join(root, 'absent') }
  for (const key of Object.keys(env)) if (key.startsWith('OMEM_') && key !== 'OMEM_ENV_FILE' || key === 'GITHUB_TOKEN' || key === 'GH_TOKEN') delete (env as NodeJS.ProcessEnv)[key]
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  for (const args of [['--help'], ['-h'], ['help'], ['skills', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /usage:/)
    assert.equal(result.stderr, '')
  }
  const bad = spawnSync(process.execPath, [cli, '--bad-flag'], { env, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /Run omem --help/)
  assert.doesNotMatch(bad.stderr, /at .*cli|node:internal|ERR_PARSE_ARGS/)
  assert.match(bad.stderr, /invalid JSON/)
  assert.doesNotMatch(bad.stderr, /\{invalid/)
})

test('Codex repair backs up and preserves unrelated sections and Omem environment settings', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omem-repair-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'config.toml')
  const original = 'model = "test"\n[mcp_servers.omem]\ncommand = "missing"\nargs = ["serve"]\n[mcp_servers.omem.env]\nOMEM_USAGE_LOG = "off"\n[mcp_servers.other]\ncommand = "other"\n'
  writeFileSync(path, original)
  await registerCodex(path, [process.execPath, 'entry.mjs', 'serve'])
  assert.equal(readFileSync(`${path}.omem-backup`, 'utf8'), original)
  const repaired = readFileSync(path, 'utf8')
  assert.ok(repaired.startsWith('model = "test"'))
  assert.ok(repaired.endsWith('[mcp_servers.omem.env]\nOMEM_USAGE_LOG = "off"\n[mcp_servers.other]\ncommand = "other"\n'))
  assert.equal((repaired.match(/\[mcp_servers\.omem\]/g) ?? []).length, 1)
  assert.equal((await checkLaunch(path)).status, 'launchable')
})

test('doctor preserves index failure and does not report zero chunks for an unreadable index', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omem-doctor-error-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.omem'))
  writeFileSync(join(root, '.omem', 'index.db'), 'not a database')
  const report = await checkDoctor(root)
  assert.equal(report.db, false)
  assert.equal(report.totalChunks, null)
  assert.equal(report.pendingEmbeddings, null)
  assert.ok(report.errors.some(error => error.operation === 'open/read index' && error.code !== 'UNKNOWN'))
})

test('Windows executable metadata is reserved, validated, and excluded from skill assets', t => {
  const root = mkdtempSync(join(tmpdir(), 'omem-executable-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = [{ path: 'SKILL.md', content: '---\nname: alpha\ndescription: Example\n---\nExample', encoding: 'utf8' as const, executable: false }]
  assert.throws(() => createBundle([...files, { ...files[0], path: '.omem-executables.json' }]), /reserved/)
  const directory = join(root, 'alpha')
  writeBundle(directory, files)
  writeFileSync(join(directory, '.omem-executables.json'), JSON.stringify(['missing.sh']))
  assert.throws(() => readBundle(directory), /missing file/)
  writeFileSync(join(directory, '.omem-executables.json'), '[]')
  const result = readBundle(directory)
  assert.deepEqual(result.manifest.map(file => file.path), ['SKILL.md'])
  assert.equal(result.revision, createBundle(files).revision)
})
