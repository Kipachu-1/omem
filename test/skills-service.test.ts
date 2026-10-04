import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkillsService, readSkillsWatchConfig, skillsServiceStatus, skillWatchConfigSchema, uninstallSkillsService, SKILLS_SERVICE_LABEL, type LaunchctlRunner, type SkillWatchConfig, type ServiceOptions } from '../src/skills/service.ts'

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'omem-service-')))
  const stateDir = join(home, 'state', 'omem')
  const calls: string[][] = []
  let loaded = false
  let running = false
  let failBootstrap = false
  let failPrint = false
  let failBootout = false
  const run: LaunchctlRunner = async args => {
    calls.push(args)
    switch (args[0]) {
      case 'print':
        if (failPrint) throw new Error('launchctl unavailable')
        if (!loaded) throw Object.assign(new Error('No such service'), { code: 113 })
        return { stdout: `state = ${running ? 'running' : 'waiting'}` }
      case 'bootstrap':
        if (failBootstrap) throw new Error('bootstrap rejected')
        loaded = true
        running = true
        return { stdout: '' }
      case 'bootout':
        if (failBootout) throw new Error('bootout rejected')
        loaded = false
        running = false
        return { stdout: '' }
      default: throw new Error(`Unexpected launchctl operation: ${args[0]}`)
    }
  }
  const options = { home, stateDir, platform: 'darwin', uid: process.getuid?.() ?? 0, run, nodePath: '/usr/local/bin/node', cliPath: '/opt/omem/bin/omem.mjs' } satisfies ServiceOptions
  const config: SkillWatchConfig = { source: { kind: 'local', vault: join(home, 'vault') }, interval: 15 }
  return { home, stateDir, options, config, calls, setRunning: (value: boolean) => { running = value }, setLoaded: (value: boolean) => { loaded = value }, failBootstrap: () => { failBootstrap = true }, failPrint: () => { failPrint = true }, failBootout: () => { failBootout = true }, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('skills service installs, repeats without restarting, updates and uninstalls its own files', async () => {
  const f = fixture()
  try {
    const installed = await installSkillsService({ ...f.options, config: f.config })
    assert.equal(installed.installed, true)
    assert.equal(installed.running, true)
    assert.deepEqual(f.calls.map(call => call[0]), ['print', 'bootstrap', 'print'])
    assert.deepEqual(readSkillsWatchConfig(installed.configPath), f.config)
    f.calls.length = 0
    await installSkillsService({ ...f.options, config: f.config })
    assert.deepEqual(f.calls.map(call => call[0]), ['print'])
    f.calls.length = 0
    await installSkillsService({ ...f.options, config: { ...f.config, claude: true } })
    assert.deepEqual(f.calls.map(call => call[0]), ['print', 'bootout', 'bootstrap', 'print'])
    assert.deepEqual(f.calls[1], ['bootout', `gui/${f.options.uid}/${SKILLS_SERVICE_LABEL}`])
    assert.equal((await skillsServiceStatus(f.options)).running, true)
    const stateFile = join(f.stateDir, 'skills-sync.db')
    writeFileSync(stateFile, 'preserve state')
    const uninstalled = await uninstallSkillsService(f.options)
    assert.equal(uninstalled.installed, false)
    assert.equal(existsSync(installed.plistPath), false)
    assert.equal(existsSync(installed.configPath), false)
    assert.equal(readFileSync(stateFile, 'utf8'), 'preserve state')
    assert.equal(existsSync(join(f.stateDir, 'logs', 'skills-service.stderr.log')), true)
    f.calls.length = 0
    assert.equal((await uninstallSkillsService(f.options)).installed, false)
    assert.deepEqual(f.calls.map(call => call[0]), ['print'])
  } finally { f.cleanup() }
})

test('remote service credentials exist only in an owner-only saved profile', async () => {
  const f = fixture()
  try {
    const token = 'secret-service-token'
    const config: SkillWatchConfig = { source: { kind: 'remote', url: 'https://memory.example/mcp', token }, legacyWindsurf: true }
    const result = await installSkillsService({ ...f.options, config })
    assert.equal(readSkillsWatchConfig(result.configPath).source.kind, 'remote')
    assert.equal(readFileSync(result.configPath, 'utf8').includes(token), true)
    assert.equal(readFileSync(result.plistPath, 'utf8').includes(token), false)
    assert.equal(JSON.stringify(f.calls).includes(token), false)
    assert.equal(JSON.stringify(result).includes(token), false)
    assert.equal(statSync(f.stateDir).mode & 0o777, 0o700)
    for (const path of [result.configPath, result.plistPath, join(f.stateDir, 'logs', 'skills-service.stdout.log'), join(f.stateDir, 'logs', 'skills-service.stderr.log')]) {
      assert.equal(statSync(path).mode & 0o777, 0o600)
    }
    const plist = readFileSync(result.plistPath, 'utf8')
    assert.equal(plist.includes('<key>ThrottleInterval</key><integer>30</integer>'), true)
    assert.equal(plist.includes('<string>--skills-home</string>'), true)
    assert.equal(plist.includes('<string>--skills-state-dir</string>'), true)
    assert.equal(plist.includes('<key>EnvironmentVariables</key>'), false)
  } finally { f.cleanup() }
})

test('skills service restarts a loaded but nonrunning job and bootstraps an unloaded job', async () => {
  const f = fixture()
  try {
    await installSkillsService({ ...f.options, config: f.config })
    f.setRunning(false)
    f.calls.length = 0
    await installSkillsService({ ...f.options, config: f.config })
    assert.deepEqual(f.calls.map(call => call[0]), ['print', 'bootout', 'bootstrap', 'print'])
    f.setLoaded(false)
    f.calls.length = 0
    await installSkillsService({ ...f.options, config: f.config })
    assert.deepEqual(f.calls.map(call => call[0]), ['print', 'bootstrap', 'print'])
  } finally { f.cleanup() }
})

test('skills service XML escapes executable paths', async () => {
  const f = fixture()
  try {
    const result = await installSkillsService({ ...f.options, config: f.config, cliPath: '/opt/a & <b> "c"/omem.mjs' })
    const plist = readFileSync(result.plistPath, 'utf8')
    assert.equal(plist.includes('/opt/a &amp; &lt;b&gt; &quot;c&quot;/omem.mjs'), true)
  } finally { f.cleanup() }
})

test('skills service rejects non-macOS without writes or launchctl calls', async () => {
  const f = fixture()
  try {
    const options = { ...f.options, platform: 'linux' } satisfies ServiceOptions
    await assert.rejects(installSkillsService({ ...options, config: f.config }), /require macOS/)
    await assert.rejects(skillsServiceStatus(options), /require macOS/)
    await assert.rejects(uninstallSkillsService(options), /require macOS/)
    assert.equal(existsSync(f.stateDir), false)
    assert.deepEqual(f.calls, [])
  } finally { f.cleanup() }
})

test('skills service uses XDG_CONFIG_HOME for its private profile', async () => {
  const f = fixture()
  const previous = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = join(f.home, 'xdg')
    const { stateDir: _stateDir, ...options } = f.options
    const result = await installSkillsService({ ...options, config: f.config })
    assert.equal(result.configPath, join(f.home, 'xdg', 'omem', 'skills-service.json'))
    assert.equal(statSync(join(f.home, 'xdg', 'omem')).mode & 0o777, 0o700)
    await uninstallSkillsService(options)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    f.cleanup()
  }
})

test('skills service reports bootstrap failure and preserves the saved profile for retry', async () => {
  const f = fixture()
  try {
    f.failBootstrap()
    await assert.rejects(installSkillsService({ ...f.options, config: f.config }), /Could not bootstrap/)
    const result = await skillsServiceStatus(f.options)
    assert.equal(result.installed, true)
    assert.equal(result.running, false)
    assert.deepEqual(readSkillsWatchConfig(result.configPath), f.config)
  } finally { f.cleanup() }
})

test('skills service refuses unknown launchctl failures and preserves files when stopping fails', async () => {
  const f = fixture()
  try {
    const result = await installSkillsService({ ...f.options, config: f.config })
    f.failBootout()
    await assert.rejects(uninstallSkillsService(f.options), /Could not stop/)
    assert.equal(existsSync(result.configPath), true)
    assert.equal(existsSync(result.plistPath), true)
    f.failPrint()
    await assert.rejects(skillsServiceStatus(f.options), /Could not inspect/)
  } finally { f.cleanup() }
})

test('skills service refuses another LaunchAgent and does not stop a colliding loaded label', async () => {
  const f = fixture()
  try {
    f.setLoaded(true)
    await assert.rejects(installSkillsService({ ...f.options, config: f.config }), /without an owned LaunchAgent/)
    await assert.rejects(uninstallSkillsService(f.options), /without an owned LaunchAgent/)
    assert.equal(f.calls.some(call => call[0] === 'bootout'), false)
    f.setLoaded(false)
    const dir = join(f.home, 'Library', 'LaunchAgents')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${SKILLS_SERVICE_LABEL}.plist`)
    writeFileSync(path, '<plist>another app</plist>', { mode: 0o600 })
    await assert.rejects(installSkillsService({ ...f.options, config: f.config }), /not owned/)
    await assert.rejects(uninstallSkillsService(f.options), /not owned/)
    assert.equal(readFileSync(path, 'utf8'), '<plist>another app</plist>')
  } finally { f.cleanup() }
})

test('skills service refuses symlinked state directories and preserves their targets', async () => {
  const f = fixture()
  try {
    const target = join(f.home, 'other')
    mkdirSync(target)
    symlinkSync(target, join(f.home, 'state'))
    await assert.rejects(installSkillsService({ ...f.options, config: f.config }), /Unsafe service directory/)
    assert.equal(existsSync(join(target, 'omem')), false)
    assert.deepEqual(f.calls, [])
  } finally { f.cleanup() }
})

test('skills service refuses symlinked owned files, including dangling symlinks', async () => {
  const f = fixture()
  try {
    mkdirSync(f.stateDir, { recursive: true })
    const configPath = join(f.stateDir, 'skills-service.json')
    const target = join(f.home, 'secret')
    writeFileSync(target, 'other secret', { mode: 0o600 })
    symlinkSync(target, configPath)
    await assert.rejects(installSkillsService({ ...f.options, config: f.config }), /safely read/)
    await assert.rejects(uninstallSkillsService(f.options), /safely read/)
    assert.equal(readFileSync(target, 'utf8'), 'other secret')
    rmSync(configPath)
    symlinkSync(join(f.home, 'missing'), configPath)
    await assert.rejects(installSkillsService({ ...f.options, config: f.config }), /safely read/)
  } finally { f.cleanup() }
})

test('skills service config loader refuses exposed credentials and invalid profiles', async () => {
  const f = fixture()
  try {
    const result = await installSkillsService({ ...f.options, config: f.config })
    chmodSync(result.configPath, 0o644)
    assert.throws(() => readSkillsWatchConfig(result.configPath), /mode 0600/)
    await assert.rejects(uninstallSkillsService(f.options), /mode 0600/)
    chmodSync(result.configPath, 0o600)
    writeFileSync(result.configPath, '{invalid')
    assert.throws(() => readSkillsWatchConfig(result.configPath), /not a valid omem watch profile/)
    await assert.rejects(installSkillsService({ ...f.options, config: f.config }), /not a valid omem watch profile/)
  } finally { f.cleanup() }
})

test('watch config schema rejects credential URLs, extra fields and invalid intervals', () => {
  assert.equal(skillWatchConfigSchema.safeParse({ source: { kind: 'remote', url: 'https://user:secret@example.com/mcp' } }).success, false)
  assert.equal(skillWatchConfigSchema.safeParse({ source: { kind: 'remote', url: 'file:///tmp/mcp' } }).success, false)
  assert.equal(skillWatchConfigSchema.safeParse({ source: { kind: 'local', vault: 'relative' } }).success, false)
  assert.equal(skillWatchConfigSchema.safeParse({ source: { kind: 'local', vault: '/vault', token: 'secret' } }).success, false)
  assert.equal(skillWatchConfigSchema.safeParse({ source: { kind: 'local', vault: '/vault' }, interval: 0 }).success, false)
})
