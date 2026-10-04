import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/mcp/server.ts'
import { openDb, type DB } from '../src/db.ts'
import { fullIndex, indexFile } from '../src/indexer.ts'
import { skillDetailsSchema, skillFileSchema } from '../src/skills/bundle.ts'
import { bow } from './helpers/bow.ts'

let vault: string
let db: DB
let client: Client
let server: ReturnType<typeof buildServer>
const name = 'shared-review'
const raw = `---\nname: ${name}\ndescription: Review implementation and verify user behavior\nmetadata:\n  owner: kipachu\n---\n# Review\nRead references/checklist.md and run scripts/check.sh.\n`
const files = [
  { path: 'SKILL.md', content: raw },
  { path: 'references/checklist.md', content: 'Verify the observed behavior.' },
  { path: 'scripts/check.sh', content: '#!/bin/sh\nprintf "checked\\n"\n', executable: true },
  { path: 'assets/example.bin', content: Buffer.from([0xff, 0, 0xfe, 8]).toString('base64'), encoding: 'base64' },
]
const responseSchema = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough()
async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const response = responseSchema.parse(await client.callTool({ name: tool, arguments: args }))
  assert.ok(!response.isError, response.content[0]?.text)
  return JSON.parse(response.content[0]?.text ?? 'null')
}

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), 'omem-skills-mcp-'))
  db = openDb(join(vault, '.omem', 'index.db'))
  server = buildServer(db, vault, bow, () => 'skill-test')
  client = new Client({ name: 'skills-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
})
afterEach(async () => {
  await client.close()
  await server.close()
  db.close()
  rmSync(vault, { recursive: true, force: true })
})

test('skills over MCP preserve complete bundles and provide progressive discovery', async () => {
  const created = skillDetailsSchema.parse(await call('skill_write', { name, files, expectedRevision: null }))
  const listing = z.object({ skills: z.array(z.object({ name: z.string(), description: z.string() }).passthrough()), total: z.number() }).parse(await call('skill_list', { query: 'review' }))
  assert.equal(listing.total, 1)
  assert.equal(listing.skills[0]?.name, name)
  assert.ok(!('instructions' in listing.skills[0]!))
  const details = skillDetailsSchema.parse(await call('skill_get', { name }))
  assert.equal(details.revision, created.revision)
  assert.equal(details.manifest.length, 4)
  assert.match(details.instructions, /Read references\/checklist/)
  const entry = skillFileSchema.parse(await call('skill_read_file', { name, path: 'SKILL.md', expectedRevision: details.revision }))
  assert.equal(entry.content, raw)
  const binary = skillFileSchema.parse(await call('skill_read_file', { name, path: 'assets/example.bin', expectedRevision: details.revision }))
  assert.deepEqual(Buffer.from(binary.content, 'base64'), Buffer.from([0xff, 0, 0xfe, 8]))
  const script = skillFileSchema.parse(await call('skill_read_file', { name, path: 'scripts/check.sh', expectedRevision: details.revision }))
  assert.equal(script.executable, true)
  fullIndex(db, vault)
  assert.deepEqual(await call('memory_search', { query: 'checklist' }), [])
})

test('skill updates and archives reject stale revisions and preserve omitted files', async () => {
  const first = skillDetailsSchema.parse(await call('skill_write', { name, files, expectedRevision: null }))
  const updated = skillDetailsSchema.parse(await call('skill_write', { name, files: [{ path: 'references/checklist.md', content: 'Updated checklist' }], expectedRevision: first.revision }))
  assert.notEqual(updated.revision, first.revision)
  assert.equal(updated.manifest.length, 4)
  const conflict = responseSchema.parse(await client.callTool({ name: 'skill_write', arguments: { name, files: [{ path: 'SKILL.md', content: raw }], expectedRevision: first.revision } }))
  assert.equal(conflict.isError, true)
  const archive = z.object({ archived: z.string() }).parse(await call('skill_archive', { name, expectedRevision: updated.revision }))
  assert.equal(readFileSync(join(vault, archive.archived, 'references/checklist.md'), 'utf8'), 'Updated checklist')
  assert.equal(z.object({ total: z.number() }).parse(await call('skill_list', {})).total, 0)
})

test('memory tools cannot mutate skill directories', async () => {
  const response = responseSchema.parse(await client.callTool({ name: 'memory_write', arguments: { title: 'Unsafe', content: 'unsafe', folder: 'skills' } }))
  assert.equal(response.isError, true)
  assert.match(response.content[0]?.text ?? '', /reserved for skill/)
  const normal = z.object({ path: z.string() }).parse(await call('memory_write', { title: 'Normal', content: 'normal memory note' }))
  const move = responseSchema.parse(await client.callTool({ name: 'memory_move', arguments: { from: normal.path, to: 'archive/skills/moved.md' } }))
  assert.equal(move.isError, true)
})

test('skill tools advertise read-only discovery and redact uploads in usage logs', async () => {
  const advertised = await client.listTools()
  for (const toolName of ['skill_list', 'skill_get', 'skill_read_file']) {
    assert.equal(advertised.tools.find(tool => tool.name === toolName)?.annotations?.readOnlyHint, true)
  }
  assert.ok((client.getInstructions()?.length ?? 401) <= 400)
  const events: unknown[] = []
  const previous = console.error
  console.error = (value: unknown) => { if (typeof value === 'string' && value.startsWith('{')) events.push(JSON.parse(value)) }
  try {
    await call('skill_write', { name, files: [{ path: 'SKILL.md', content: raw + 'private-upload-sentinel' }], expectedRevision: null })
    const invalid = responseSchema.parse(await client.callTool({ name: 'skill_write', arguments: {
      name: 'invalid-review', expectedRevision: null,
      files: [{ path: 'SKILL.md', content: '---\nname: invalid-review\ndescription: [private-error-sentinel\n---\n' }],
    } }))
    assert.equal(invalid.isError, true)
  } finally { console.error = previous }
  const event = z.object({ tool: z.string(), args: z.object({ files: z.string() }) }).parse(events.find(value => z.object({ tool: z.string() }).parse(value).tool === 'skill_write'))
  assert.equal(event.args.files, '<redacted>')
  assert.ok(!JSON.stringify(events).includes('private-upload-sentinel'))
  assert.ok(!JSON.stringify(events).includes('private-error-sentinel'))
})

test('index sweeps remove previously indexed skill notes and preserve nested memory topics', () => {
  mkdirSync(join(vault, 'skills', name), { recursive: true })
  writeFileSync(join(vault, 'skills', name, 'SKILL.md'), raw)
  db.prepare('INSERT INTO notes(path,title,mtime,hash) VALUES (?,?,?,?)').run(`skills/${name}/SKILL.md`, 'Previously indexed skill', 0, 'legacy-hash')
  mkdirSync(join(vault, 'topics', 'skills'), { recursive: true })
  writeFileSync(join(vault, 'topics', 'skills', 'facts.md'), 'Facts about skill formats')
  const result = fullIndex(db, vault)
  assert.equal(result.removed, 1)
  assert.deepEqual(db.prepare('SELECT path FROM notes').all(), [{ path: 'topics/skills/facts.md' }])
  assert.equal(indexFile(db, vault, `skills/${name}/SKILL.md`), false)
})

test('MCP startup removes old indexed skill notes before any memory calls or filesystem sweep', async () => {
  db.prepare('INSERT INTO notes(path,title,mtime,hash) VALUES (?,?,?,?)').run('skills/legacy/SKILL.md', 'Old skill', 0, 'legacy-hash')
  const row = db.prepare('INSERT INTO chunks(note_path,text,position) VALUES (?,?,?)').run('skills/legacy/SKILL.md', 'legacy workflow sentinel', 0)
  db.prepare('INSERT INTO chunks_fts(rowid,text) VALUES (?,?)').run(row.lastInsertRowid, 'legacy workflow sentinel')
  const fresh = buildServer(db, vault, bow)
  try {
    assert.deepEqual(await call('memory_search', { query: 'legacy workflow sentinel' }), [])
    assert.equal(z.object({ n: z.number() }).parse(db.prepare('SELECT count(*) AS n FROM notes').get()).n, 0)
    assert.equal(z.object({ n: z.number() }).parse(db.prepare('SELECT count(*) AS n FROM chunks_fts').get()).n, 0)
  } finally { await fresh.close() }
})
