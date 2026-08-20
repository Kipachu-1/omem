import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpJson, jsonRegistered, tomlRegistered, offerAgents, type Agent, type AgentState } from '../src/agents.ts'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'omem-agents-'))

test('mcpJson merges omem into an existing config without clobbering it', async () => {
  const tmp = scratch()
  try {
    const path = join(tmp, 'deep', 'mcp.json')
    // fresh file (missing parent dir) gets created
    await mcpJson(path)(['omem', 'serve'])
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).mcpServers.omem, { command: 'omem', args: ['serve'] })
    // existing servers and unrelated keys survive; omem entry is overwritten, not duplicated
    writeFileSync(path, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' }, omem: { command: 'old' } } }))
    await mcpJson(path)(['npx', '-y', '@kipachu/omem', 'serve'])
    const cfg = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(cfg.theme, 'dark')
    assert.deepEqual(cfg.mcpServers.other, { command: 'x' })
    assert.deepEqual(cfg.mcpServers.omem, { command: 'npx', args: ['-y', '@kipachu/omem', 'serve'] })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('jsonRegistered: missing file → missing, entry → registered, unparseable → unknown', () => {
  const tmp = scratch()
  try {
    const path = join(tmp, 'cfg.json')
    const hasOmem = (cfg: Record<string, unknown>): boolean =>
      !!(cfg.mcpServers as Record<string, unknown> | undefined)?.omem
    assert.equal(jsonRegistered(path, hasOmem), 'missing', 'no file → missing')
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    assert.equal(jsonRegistered(path, hasOmem), 'missing', 'file without omem entry → missing')
    writeFileSync(path, JSON.stringify({ mcpServers: { omem: { command: 'omem' } } }))
    assert.equal(jsonRegistered(path, hasOmem), 'registered', 'omem entry → registered')
    writeFileSync(path, '{ not json')
    assert.equal(jsonRegistered(path, hasOmem), 'unknown', 'unparseable → unknown')
    writeFileSync(path, '"just a string"')
    assert.equal(jsonRegistered(path, hasOmem), 'unknown', 'non-object root → unknown')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('tomlRegistered: missing file → missing, section → registered, no section → missing', () => {
  const tmp = scratch()
  try {
    const path = join(tmp, 'config.toml')
    assert.equal(tomlRegistered(path), 'missing')
    writeFileSync(path, '[mcp_servers.other]\ncommand = "x"\n')
    assert.equal(tomlRegistered(path), 'missing')
    writeFileSync(path, '[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.omem]\ncommand = "omem"\n')
    assert.equal(tomlRegistered(path), 'registered')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

const fakeAgent = (name: string, state: AgentState | undefined, calls: string[]): Agent => ({
  name,
  state: state === undefined ? undefined : () => state,
  register: async () => {
    calls.push(name)
    return `wrote ${name}`
  },
})

test('offerAgents skips already-registered agents and prompts for the rest', async () => {
  const calls: string[] = []
  const asked: string[] = []
  const found = [
    fakeAgent('Regd', 'registered', calls),
    fakeAgent('Missing', 'missing', calls),
    fakeAgent('Opaque', undefined, calls),
  ]
  await offerAgents(
    async q => {
      asked.push(q)
      return true
    },
    found,
  )
  // registered one is never prompted nor re-registered; missing and unknown are
  assert.equal(asked.filter(q => q.includes('Regd')).length, 0, 'must not prompt for a registered agent')
  assert.equal(asked.filter(q => q.includes('Missing')).length, 1)
  assert.equal(asked.filter(q => q.includes('Opaque')).length, 1, 'unknown state is still offered')
  assert.deepEqual(calls, ['Missing', 'Opaque'])
})

test('offerAgents with yes-always registers every unregistered agent (the --yes path)', async () => {
  const calls: string[] = []
  const found = [fakeAgent('Regd', 'registered', calls), fakeAgent('A', 'missing', calls), fakeAgent('B', 'unknown', calls)]
  await offerAgents(async () => true, found)
  assert.deepEqual(calls, ['A', 'B'], 'only unregistered/unknown agents are written')
})

test('offerAgents declines leave configs untouched', async () => {
  const calls: string[] = []
  const found = [fakeAgent('Missing', 'missing', calls)]
  await offerAgents(async () => false, found)
  assert.deepEqual(calls, [])
})

test('mcpJsonAgent wiring: config path doubles as the state probe', async () => {
  // simulate the Cursor entry shape: same path for state and register
  const tmp = scratch()
  try {
    const path = join(tmp, '.cursor', 'mcp.json')
    assert.equal(jsonRegistered(path, (c) => !!(c.mcpServers as Record<string, unknown> | undefined)?.omem), 'missing')
    await mcpJson(path)(['omem', 'serve'])
    assert.equal(jsonRegistered(path, (c) => !!(c.mcpServers as Record<string, unknown> | undefined)?.omem), 'registered')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
