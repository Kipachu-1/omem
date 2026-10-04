import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { once } from 'node:events'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { openDb } from '../src/db.ts'
import { buildServer } from '../src/mcp/server.ts'
import { createBundle, skillFileSchema } from '../src/skills/bundle.ts'
import { localSkillSource, remoteSkillSource } from '../src/skills/source.ts'

function files(name = 'example') {
  return [
    { path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Test skill\n---\nUse this skill.\n`, encoding: 'utf8', executable: false },
    { path: 'asset.bin', content: 'AP8=', encoding: 'base64', executable: false },
  ].map(file => skillFileSchema.parse(file))
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  return `http://127.0.0.1:${address.port}/mcp`
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }

test('local source preserves complete bundle files, verifies revision, and rejects stale writes', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'omem-skill-source-'))
  const source = localSkillSource(vault)
  try {
    const first = await source.write({ name: 'example', files: files(), expectedRevision: null })
    assert.equal((await source.get('example')).revision, first.revision)
    assert.deepEqual((await source.get('example')).files, createBundle(files()).files)
    await assert.rejects(source.write({ name: 'example', files: files(), expectedRevision: null }), /revision|exists/i)
    assert.deepEqual((await source.list()).skills.map(skill => skill.name), ['example'])
    assert.equal(source.id, `local:${realpathSync(vault)}`)
  } finally { await source.close(); rmSync(vault, { recursive: true, force: true }) }
})

test('authenticated HTTP source uses MCP tools, Authorization header, full file verification and CAS writes', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'omem-skill-http-'))
  const db = openDb(join(vault, '.omem', 'index.db'))
  const headers: (string | undefined)[] = []
  const token = 'test-bearer-only-in-header'
  const server = createServer(async (req, res) => {
    headers.push(req.headers.authorization)
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end('unauthorized'); return }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    const mcp = buildServer(db, vault, { model: 'test', async embed() { throw new Error('not needed') } })
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  })
  const url = await listen(server)
  try {
    const source = await remoteSkillSource({ url, token })
    try {
      const created = await source.write({ name: 'example', files: files(), expectedRevision: null })
      assert.deepEqual((await source.list()).skills.map(skill => skill.name), ['example'])
      const full = await source.get('example')
      assert.deepEqual(full.files, createBundle(files()).files)
      assert.equal(full.revision, created.revision)
      await assert.rejects(source.write({ name: 'example', files: files(), expectedRevision: '0'.repeat(64) }), /revision/i)
      assert.equal(source.id, `remote:${url}`)
      assert.ok(!source.id.includes(token))
      assert.ok(headers.every(value => value === `Bearer ${token}`))
    } finally { await source.close() }
    await assert.rejects(remoteSkillSource({ url, token: 'incorrect' }), error => error instanceof Error && !error.message.includes('incorrect'))
    await assert.rejects(remoteSkillSource({ url: url.replace('http://', 'http://user:secret@') }), /credentials/)
  } finally { await close(server); db.close(); rmSync(vault, { recursive: true, force: true }) }
})

test('remote source drains catalogue pagination and rejects corrupted file responses', async () => {
  const bundle = createBundle(files())
  let corrupt = false
  const server = createServer(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    const mcp = new McpServer({ name: 'source-test', version: '1' })
    const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
    mcp.registerTool('skill_list', { inputSchema: { offset: z.number().optional() } }, async ({ offset }) => json({ skills: Array.from({ length: offset ? 1 : 100 }, (_, i) => ({ name: `skill-${(offset ?? 0) + i}`, description: 'Test', revision: bundle.revision })), total: 101, diagnostics: [] }))
    mcp.registerTool('skill_get', { inputSchema: { name: z.string() } }, async () => json(bundle))
    mcp.registerTool('skill_read_file', { inputSchema: { path: z.string() } }, async ({ path }) => {
      const file = bundle.files.find(file => file.path === path)
      return json(corrupt && file?.path === 'asset.bin' ? { ...file, content: 'corrupt', encoding: 'utf8' } : file)
    })
    mcp.registerTool('skill_write', {}, async () => json(bundle))
    await mcp.connect(transport); await transport.handleRequest(req, res)
  })
  const source = await remoteSkillSource({ url: await listen(server) })
  try {
    assert.equal((await source.list()).skills.length, 101)
    assert.equal((await source.get('example')).revision, bundle.revision)
    corrupt = true
    await assert.rejects(source.get('example'), /verification|frontmatter/)
    corrupt = false
    await assert.rejects(source.get('different-name'), /match|verification/)
  } finally { await source.close(); await close(server) }
})

test('remote source reports an older server without required skill tools', async () => {
  const server = createServer(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    const mcp = new McpServer({ name: 'old-server', version: '1' })
    mcp.registerTool('memory_search', {}, async () => ({ content: [] }))
    await mcp.connect(transport); await transport.handleRequest(req, res)
  })
  try { await assert.rejects(remoteSkillSource({ url: await listen(server) }), /required tools.*skill_list.*Upgrade/) }
  finally { await close(server) }
})

test('local source shares the configured OMEM_DB_PATH used by the server', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'omem-skill-configured-db-'))
  const configured = join(vault, 'custom', 'index.db')
  const previous = process.env.OMEM_DB_PATH
  process.env.OMEM_DB_PATH = configured
  const source = localSkillSource(vault)
  try {
    await source.write({ name: 'example', files: files(), expectedRevision: null })
    assert.equal(existsSync(configured), true)
    assert.equal(existsSync(join(vault, '.omem', 'index.db')), false)
    const db = openDb(configured)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    assert.ok(tables.length > 0)
    db.close()
  } finally {
    await source.close()
    if (previous === undefined) delete process.env.OMEM_DB_PATH
    else process.env.OMEM_DB_PATH = previous
    rmSync(vault, { recursive: true, force: true })
  }
})
