import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/vault', import.meta.url))

let vault: string
let client: Client

const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean }
  assert.ok(!res.isError, `tool ${name} errored: ${res.content?.[0]?.text}`)
  return JSON.parse(res.content[0].text)
}

before(async () => {
  vault = mkdtempSync(join(tmpdir(), 'omem-session-'))
  cpSync(FIXTURE, vault, { recursive: true })
  client = new Client({ name: 'omem-test', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'src/cli.ts'), 'serve', '--vault', vault, '--poll', '3600'],
      stderr: 'ignore',
    }),
  )
})

after(async () => {
  await client.close()
  rmSync(vault, { recursive: true, force: true })
})

test('memory_session_show returns empty for unknown session', async () => {
  const r = await call('memory_session_show', { id: 'nonexistent-arc' })
  assert.equal(r.notes.length, 0)
  assert.equal(r.wikilink_subgraph.nodes.length, 0)
  assert.equal(r.wikilink_subgraph.edges.length, 0)
})

test('memory_session_show returns tagged notes mtime-ordered with arc digest', async () => {
  // write 3 notes tagged session/test-arc
  await call('memory_write', {
    title: 'Session Note Alpha',
    content: 'First note in the test arc.\n\nLinks to [[Session Note Beta]].',
    folder: 'memory',
    tags: ['session/test-arc'],
    frontmatter: { kind: 'decision', confidence: 0.9 },
  })
  await call('memory_write', {
    title: 'Session Note Beta',
    content: 'Second note in the test arc.',
    folder: 'memory',
    tags: ['session/test-arc'],
    frontmatter: { kind: 'gotcha', confidence: 0.8 },
  })
  await call('memory_write', {
    title: 'Session Note Gamma',
    content: 'Third note in the test arc.',
    folder: 'memory',
    tags: ['session/test-arc'],
    frontmatter: { kind: 'fact', confidence: 1.0 },
  })

  const r = await call('memory_session_show', { id: 'test-arc' })
  assert.equal(r.id, 'test-arc')
  assert.equal(r.notes.length, 3, `expected 3 notes, got ${r.notes.length}`)

  // mtime-ordered (ascending)
  for (let i = 1; i < r.notes.length; i++) {
    assert.ok(
      r.notes[i - 1].modified <= r.notes[i].modified,
      `notes should be mtime-ordered: ${r.notes[i - 1].modified} <= ${r.notes[i].modified}`,
    )
  }

  // arc digest contains count + date range
  assert.ok(r.arc_digest.includes('3 notes'), `arc_digest should contain count: ${r.arc_digest}`)
  assert.ok(r.arc_digest.includes('decision'), `arc_digest should mention kinds: ${r.arc_digest}`)

  // each note has path, title, kind, modified, first_line, link
  for (const n of r.notes) {
    assert.ok(n.path, 'note has path')
    assert.ok(n.title, 'note has title')
    assert.ok(n.kind, 'note has kind')
    assert.ok(n.modified, 'note has modified')
    assert.ok(n.link, 'note has link')
    // first_line should be non-empty (it's the body text)
    assert.ok(typeof n.first_line === 'string', 'note has first_line')
  }

  // wikilink subgraph: Alpha links to Beta
  assert.ok(r.wikilink_subgraph.nodes.length >= 2, 'subgraph has nodes')
  assert.ok(r.wikilink_subgraph.edges.length >= 1, 'subgraph has edges')
  const hasAlphaToBeta = r.wikilink_subgraph.edges.some(
    (e: { source: string; target: string }) =>
      e.source.includes('alpha') && e.target.includes('beta'),
  )
  assert.ok(hasAlphaToBeta, 'subgraph should contain Alpha→Beta wikilink edge')
})
