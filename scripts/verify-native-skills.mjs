#!/usr/bin/env node
// Run only native listing commands. No prompts, inference, global skill writes or HOME overrides.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const NAME = 'omem-native-check'
const SCRIPT_OUTPUT = 'OMEM_NATIVE_CHECK_SCRIPT_OK\n'
const REFERENCE = 'OMEM_NATIVE_CHECK_REFERENCE_OK\n'
const clients = process.argv.slice(2)
const supported = new Set(['gemini', 'opencode', 'codex'])
if (!clients.length || clients.some(name => !supported.has(name))) {
  process.stderr.write('Usage: node scripts/verify-native-skills.mjs gemini [opencode] [codex]\nSupported read-only native listing clients: gemini, opencode, codex.\n')
  process.exit(2)
}

function executable(client) {
  const configured = process.env[`OMEM_NATIVE_${client.toUpperCase()}_BIN`]
  if (configured) return configured
  const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
  if (client === 'codex' && existsSync(bundledCodex)) return bundledCodex
  const brew = `/opt/homebrew/bin/${client}`
  return existsSync(brew) ? brew : client
}

async function codexListing(cwd) {
  const child = spawn(executable('codex'), ['app-server', '--stdio', '-c', 'analytics.enabled=false'], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 1
  let buffered = ''
  let diagnostics = ''
  child.stderr.on('data', data => { diagnostics = `${diagnostics}${data}`.slice(-16384) })
  const rejectPending = () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new Error('Codex native listing process stopped; raw diagnostics withheld'))
    }
    pending.clear()
  }
  child.on('error', rejectPending)
  child.on('exit', rejectPending)
  child.stdin.on('error', rejectPending)
  child.stdout.on('data', data => {
    buffered += data
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      let response
      try { response = JSON.parse(line) } catch { continue }
      const request = pending.get(response.id)
      if (!request) continue
      pending.delete(response.id)
      clearTimeout(request.timer)
      if (response.error) request.reject(new Error(`Codex native listing protocol error (${response.error.code}); raw diagnostics withheld`))
      else request.resolve(response.result)
    }
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Codex native listing timed out; raw diagnostics withheld'))
    }, 20000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  const close = () => { rejectPending(); child.kill(); diagnostics = '' }
  try {
    await request('initialize', {
      clientInfo: { name: 'omem_native_skill_verification', version: '1.0.0' },
      capabilities: { explicitGatewayOauth: true },
    })
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    return {
      list: async () => {
        const result = await request('skills/list', { cwds: [cwd], forceReload: true })
        assert.ok(Array.isArray(result?.data), 'Codex listing must return cwd entries')
        return result.data.filter(entry => entry.cwd === cwd).flatMap(entry => entry.skills)
          .filter(entry => entry.name === NAME).map(entry => ({ description: entry.description, location: entry.path }))
      },
      close,
    }
  } catch (error) { close(); throw error }
}

async function command(client, args, cwd) {
  try {
    // Retain diagnostic output in memory. Never print unrelated global skills.
    return await exec(executable(client), args, { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown'
    throw new Error(`${client} native listing failed (${code}); raw client diagnostics withheld`)
  }
}

async function discover(client, cwd, codex) {
  if (client === 'codex') return codex.list()
  const args = client === 'gemini' ? ['skills', 'list'] : ['--pure', 'debug', 'skill']
  const { stdout } = await command(client, args, cwd)
  if (client === 'opencode') {
    let parsed
    try { parsed = JSON.parse(stdout) } catch { throw new Error('OpenCode listing did not return JSON') }
    assert.ok(Array.isArray(parsed), 'OpenCode listing must return an array')
    return parsed.filter(entry => entry?.name === NAME).map(entry => ({
      description: entry.description,
      location: entry.location,
    }))
  }
  const lines = stdout.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
  const entries = []
  for (let index = 0; index < lines.length; index++) {
    if (!new RegExp(`^${NAME} \\[`).test(lines[index].trim())) continue
    const block = lines.slice(index + 1, index + 6)
    entries.push({
      description: block.find(line => /^\s*Description:/.test(line))?.replace(/^\s*Description:\s*/, ''),
      location: block.find(line => /^\s*Location:/.test(line))?.replace(/^\s*Location:\s*/, ''),
    })
  }
  return entries
}

function skillText(version) {
  return `---\nname: ${NAME}\ndescription: omem native verification ${version}.\n---\n# Native verification ${version}\n\nRead references/expected.txt and run scripts/check.mjs with Node.\n`
}

async function verify(client) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'omem-native-skills-')))
  const skill = join(project, '.agents', 'skills', NAME)
  const alias = join(project, '.claude', 'skills', NAME)
  let codex
  try {
    mkdirSync(join(skill, 'scripts'), { recursive: true })
    mkdirSync(join(skill, 'references'), { recursive: true })
    mkdirSync(dirname(alias), { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), skillText('version-one'))
    writeFileSync(join(skill, 'scripts', 'check.mjs'), `process.stdout.write(${JSON.stringify(SCRIPT_OUTPUT)})\n`)
    writeFileSync(join(skill, 'references', 'expected.txt'), REFERENCE)
    symlinkSync(skill, alias, 'dir')
    await exec('git', ['init', '--quiet'], { cwd: project, timeout: 10000 })
    if (client === 'codex') codex = await codexListing(project)

    const initial = await discover(client, project, codex)
    assert.equal(initial.length, 1, `${client} must discover the sentinel exactly once with shared and Claude paths present`)
    assert.equal(initial[0].description, 'omem native verification version-one.', `${client} must discover the first description`)
    assert.equal(typeof initial[0].location, 'string', `${client} must expose the discovered file location`)
    assert.equal(realpathSync(initial[0].location), join(skill, 'SKILL.md'), `${client} must resolve the temporary sentinel`)
    const discoveredDir = dirname(initial[0].location)
    assert.equal(readFileSync(join(discoveredDir, 'references', 'expected.txt'), 'utf8'), REFERENCE, 'Reference must be readable from the discovered native directory')
    const script = await exec(process.execPath, [join(discoveredDir, 'scripts', 'check.mjs')], { cwd: project, timeout: 10000 })
    assert.equal(script.stdout, SCRIPT_OUTPUT, 'Bundled script must return the literal expected output')

    writeFileSync(join(skill, 'SKILL.md'), skillText('version-two'))
    const updated = await discover(client, project, codex)
    assert.equal(updated.length, 1, `${client} must still discover one sentinel after update`)
    assert.equal(updated[0].description, 'omem native verification version-two.', `${client} must discover the updated description`)

    rmSync(alias)
    rmSync(skill, { recursive: true })
    const removed = await discover(client, project, codex)
    assert.equal(removed.length, 0, `${client} must stop discovering the removed sentinel`)
    process.stdout.write(JSON.stringify({ client, skill: NAME, discoveryCount: 1, updated: true, removed: true, referenceRead: true, scriptOutput: SCRIPT_OUTPUT.trim() }) + '\n')
  } finally {
    codex?.close()
    rmSync(project, { recursive: true, force: true })
  }
}

for (const client of [...new Set(clients)]) {
  try { await verify(client) }
  catch (error) {
    // Assertion messages contain only our sentinel expectations, never global skill values.
    process.stderr.write(`${client}: ${error instanceof Error ? error.message : 'Native verification failed'}\n`)
    process.exitCode = 1
  }
}
