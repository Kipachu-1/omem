import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpJson } from '../src/agents.ts'

test('mcpJson merges omem into an existing config without clobbering it', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'omem-agents-'))
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
