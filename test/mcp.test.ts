import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
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

const callOn = async (c: Client, name: string, args: Record<string, unknown>) => {
  const res = (await c.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean }
  assert.ok(!res.isError, `tool ${name} errored: ${res.content?.[0]?.text}`)
  return JSON.parse(res.content[0].text)
}

// right after boot the initial embedding pass may still be running; ranking
// settles once it completes — retry until it does (keyword hits work throughout)
const untilSettled = async (fn: () => Promise<boolean>, ms = 20000) => {
  const t0 = Date.now()
  while (!(await fn()) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 300))
}

before(async () => {
  vault = mkdtempSync(join(tmpdir(), 'omem-mcp-'))
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

test('server advertises memory-usage instructions', async () => {
  const instructions = client.getInstructions()
  assert.equal(typeof instructions, 'string')
  assert.ok(instructions!.length > 0, 'instructions must be non-empty')
  assert.ok(instructions!.includes('memory_search'), 'instructions must nudge memory_search')
  assert.ok(instructions!.length <= 400, `instructions must stay under ~400 chars (got ${instructions!.length})`)
})

test('exposes exactly the nine memory tools', async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(
    tools.map(t => t.name).sort(),
    ['memory_archive', 'memory_get_note', 'memory_list', 'memory_move', 'memory_recent', 'memory_search', 'memory_status', 'memory_sync', 'memory_write'],
  )
})

test('memory_list enumerates by folder and tag, memory_move relocates, memory_archive supersedes', async () => {
  await call('memory_write', { title: 'List Target', content: 'listable body', folder: 'inbox', tags: ['triage/pending'] })

  // list by folder
  const inbox = await call('memory_list', { folder: 'inbox' })
  const entry = inbox.find((n: { title: string }) => n.title === 'List Target')
  assert.ok(entry, 'note must be listed under its folder')
  // list by tag (nested prefix match)
  const tagged = await call('memory_list', { tag: 'triage' })
  assert.ok(tagged.some((n: { path: string }) => n.path === entry.path), 'tag prefix must match')

  // move: inbox triage into a folder
  const moved = await call('memory_move', { from: entry.path, to: 'projects/list-target.md' })
  assert.equal(moved.to, 'projects/list-target.md')
  assert.ok(!existsSync(join(vault, entry.path)) && existsSync(join(vault, moved.to)))
  assert.equal((await call('memory_list', { folder: 'inbox' })).length, 0, 'old index entry must be gone')

  // archive: pinned:false + archived_at, original removed, still searchable at archive/
  const arch = await call('memory_archive', { path: moved.to, reason: 'superseded in test' })
  assert.equal(arch.to, 'archive/projects/list-target.md')
  assert.ok(!existsSync(join(vault, moved.to)))
  const raw = readFileSync(join(vault, arch.to), 'utf8')
  assert.match(raw, /pinned: false/)
  assert.match(raw, /archived_reason: superseded in test/)
  const listed = await call('memory_list', { folder: 'archive' })
  assert.ok(listed.some((n: { path: string }) => n.path === arch.to), 'archived note must stay indexed')
})

test('memory_sync reports skip on a non-repo vault instead of erroring', async () => {
  const r = await call('memory_sync', {})
  assert.equal(r.skipped, 'not a repo')
})

test('memory_search returns ranked chunks with deep links', async () => {
  let r = await call('memory_search', { query: 'canvas rendering performance', limit: 5 })
  assert.ok(r.length > 0, 'keyword hits must be available immediately after boot')
  await untilSettled(async () => {
    r = await call('memory_search', { query: 'canvas rendering performance', limit: 5 })
    return r[0]?.notePath === 'projects/canvas.md'
  })
  assert.equal(r[0].notePath, 'projects/canvas.md')
  assert.ok(r[0].link.startsWith('obsidian://open?vault='))
  assert.ok(typeof r[0].score === 'number')
})

test('memory_search folder filter works over MCP', async () => {
  const r = await call('memory_search', { query: 'canvas rendering performance', folder: 'projects' })
  for (const x of r) assert.ok(x.notePath.startsWith('projects/'), x.notePath)
})

test('memory_write creates a note that is immediately searchable, then append and overwrite update it', async () => {
  const w = await call('memory_write', {
    title: 'Zebra Deployment Rule',
    content: 'Always run the zebra preflight checklist before deploys.',
    tags: ['memory', 'deploy'],
    links: ['Canvas Renderer'],
    frontmatter: { confidence: 0.9 },
  })
  assert.match(w.path, /^memory\/\d{4}-\d{2}-\d{2}-zebra-deployment-rule\.md$/)
  const raw = readFileSync(join(vault, w.path), 'utf8')
  assert.match(raw, /source: agent/)
  assert.match(raw, /confidence: 0.9/)
  assert.match(raw, /\[\[Canvas Renderer\]\]/)

  // immediately searchable — no watcher debounce race
  const s = await call('memory_search', { query: 'zebra preflight checklist' })
  assert.equal(s[0].notePath, w.path)

  await call('memory_write', { title: 'x', content: 'Addendum: zebras also need espresso.', path: w.path, mode: 'append' })
  assert.match(readFileSync(join(vault, w.path), 'utf8'), /espresso/)

  await call('memory_write', { title: 'Zebra Deployment Rule', content: 'Rewritten body.', path: w.path, mode: 'overwrite' })
  const after = readFileSync(join(vault, w.path), 'utf8')
  assert.match(after, /Rewritten body/)
  assert.doesNotMatch(after, /espresso/)
})

test('memory_write dedupes filenames with a numeric suffix', async () => {
  const a = await call('memory_write', { title: 'Same Name', content: 'first' })
  const b = await call('memory_write', { title: 'Same Name', content: 'second' })
  assert.notEqual(a.path, b.path)
  assert.match(b.path, /-same-name-2\.md$/)
})

test('memory_get_note returns content, frontmatter, backlinks', async () => {
  const n = await call('memory_get_note', { path: 'people/bob-smith.md' })
  assert.equal(n.frontmatter.title, 'Bob Smith')
  assert.match(n.content, /Backend engineer/)
  assert.ok(n.backlinks.includes('projects/canvas.md'))
  assert.ok(n.backlinks.includes('notes/hub.md'))
})

test('path traversal is rejected', async () => {
  const res = (await client.callTool({
    name: 'memory_get_note',
    arguments: { path: '../../../etc/passwd' },
  })) as { isError?: boolean }
  assert.ok(res.isError, 'escaping the vault must fail')
  assert.ok(!existsSync(join(vault, '..', 'passwd')))
})

test('memory_recent lists newest first, folder-filtered', async () => {
  const r = await call('memory_recent', { limit: 3, folder: 'memory' })
  assert.ok(r.notes.length > 0 && r.notes.length <= 3)
  for (const x of r.notes) assert.ok(x.path.startsWith('memory/'))
  const times = r.notes.map((x: { mtime: number }) => x.mtime)
  assert.deepEqual(times, [...times].sort((a, b) => b - a))
  // no `since` -> no sinceResolved field
  assert.equal('sinceResolved' in r, false)
})

test('non-canonical paths resolve to one canonical identity', async () => {
  const n = await call('memory_get_note', { path: './people//bob-smith.md' })
  assert.equal(n.path, 'people/bob-smith.md')
  assert.ok(n.backlinks.includes('projects/canvas.md'), 'backlinks must resolve via the canonical key')

  const w = await call('memory_write', { title: 'Canon Test', content: 'canonical-write-check', folder: 'memory/../memory' })
  assert.match(w.path, /^memory\/[^.][^/]*\.md$/, `expected canonical path, got ${w.path}`)
  const s = await call('memory_search', { query: 'canonical-write-check' })
  assert.equal(s.filter((x: { text: string }) => x.text.includes('canonical-write-check')).length, 1, 'no duplicate index identity')
})

test('writes into hidden/system folders are rejected', async () => {
  for (const folder of ['.obsidian', '.omem', 'notes/.private']) {
    const res = (await client.callTool({
      name: 'memory_write',
      arguments: { title: 'evil', content: 'x', folder },
    })) as { isError?: boolean }
    assert.ok(res.isError, `write into ${folder} must fail`)
  }
})

test('frontmatter param cannot spoof provenance', async () => {
  const w = await call('memory_write', {
    title: 'Provenance Test',
    content: 'check',
    frontmatter: { source: 'human', created: '1999-01-01T00:00:00Z', island: 'y-agents' },
  })
  const raw = readFileSync(join(vault, w.path), 'utf8')
  assert.match(raw, /source: agent/)
  assert.doesNotMatch(raw, /source: human/)
  assert.doesNotMatch(raw, /created: '?1999/)
  assert.match(raw, /island: y-agents/, 'non-provenance extras still pass through')
})

test('serve exits when the client closes stdin', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [join(ROOT, 'src/cli.ts'), 'serve', '--vault', vault, '--poll', '3600'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  await new Promise(r => setTimeout(r, 1500)) // let it boot
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)))
  child.stdin.end()
  const code = await Promise.race([exited, new Promise<string>(r => setTimeout(() => r('timeout'), 5000))])
  assert.notEqual(code, 'timeout', 'serve must exit on stdin EOF, not orphan itself')
})

test('memory_search after/before recency filters work over MCP', async () => {
  // future cutoff excludes all notes
  const r = await call('memory_search', { query: 'canvas', after: Date.now() + 86_400_000 })
  assert.equal(r.length, 0, 'future after-cutoff must exclude all notes')
  // epoch-0 cutoff (1970) keeps everything
  const r2 = await call('memory_search', { query: 'canvas', after: 0 })
  assert.ok(r2.length > 0, 'epoch-0 after-cutoff must keep notes')
})

test('memory_search rejects non-numeric after (zod guard)', async () => {
  const res = (await client.callTool({
    name: 'memory_search',
    arguments: { query: 'canvas', after: 'yesterday' },
  })) as { isError?: boolean }
  assert.ok(res.isError, 'string after must be rejected by the schema')
})

test('memory_status on an empty vault returns zeroed snapshot', async () => {
  const emptyVault = mkdtempSync(join(tmpdir(), 'omem-status-empty-'))
  const emptyClient = new Client({ name: 'omem-empty-test', version: '0.0.0' })
  await emptyClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'src/cli.ts'), 'serve', '--vault', emptyVault, '--poll', '3600'],
      stderr: 'ignore',
    }),
  )
  try {
    const s = await callOn(emptyClient, 'memory_status', {})
    assert.equal(s.notes, 0)
    assert.equal(s.chunks, 0)
    assert.equal(s.embedded, 0)
    assert.equal(s.lastModified, null)
    assert.equal(s.pinned, 0)
    assert.equal(s.archived, 0)
    assert.deepEqual(s.topFolders, [])
    assert.deepEqual(s.topTags, [])
    assert.deepEqual(s.recent, [])
  } finally {
    await emptyClient.close()
    rmSync(emptyVault, { recursive: true, force: true })
  }
})

test('memory_status on a populated vault reports counts, folders, tags, recent with valid links', async () => {
  const s = await call('memory_status', {})
  assert.ok(s.notes > 0, `notes > 0, got ${s.notes}`)
  assert.ok(s.chunks > 0, `chunks > 0, got ${s.chunks}`)
  assert.ok(s.embedded <= s.chunks, 'embedded cannot exceed total chunks')
  assert.equal(typeof s.lastModified, 'string')
  assert.ok(!Number.isNaN(Date.parse(s.lastModified)), 'lastModified must be ISO')
  assert.ok(Array.isArray(s.topFolders) && s.topFolders.length > 0, 'topFolders populated')
  for (const f of s.topFolders) {
    assert.equal(typeof f.folder, 'string')
    assert.ok(f.count > 0)
  }
  assert.ok(s.topFolders.length <= 10, 'topFolders capped at 10')
  assert.ok(Array.isArray(s.topTags) && s.topTags.length > 0, 'topTags populated')
  for (const t of s.topTags) {
    assert.equal(typeof t.tag, 'string')
    assert.ok(t.count > 0)
  }
  assert.ok(s.topTags.length <= 20, 'topTags capped at 20')
  assert.ok(Array.isArray(s.recent), 'recent is an array')
  assert.ok(s.recent.length <= 5, 'recent capped at 5')
  // mtimes descending
  const mtimes = s.recent.map((r: { modified: string }) => Date.parse(r.modified))
  assert.deepEqual(mtimes, [...mtimes].sort((a, b) => b - a), 'recent is newest-first')
  for (const r of s.recent) {
    assert.equal(typeof r.path, 'string')
    assert.equal(typeof r.title, 'string')
    assert.ok(r.link.startsWith('obsidian://open?vault='))
  }
})

test('memory_status is advertised as read-only', async () => {
  const { tools } = await client.listTools()
  const tool = tools.find(t => t.name === 'memory_status')
  assert.ok(tool, 'memory_status must be listed')
  assert.equal(tool.annotations?.readOnlyHint, true, 'memory_status must declare readOnlyHint')
})

test('memory_write stamps kind into frontmatter and memory_get_note reads it back', async () => {
  const w = await call('memory_write', { title: 'Kind Roundtrip', content: 'decided to ship on Friday', kind: 'decision' })
  const note = await call('memory_get_note', { path: w.path })
  assert.equal(note.frontmatter.kind, 'decision')
})

test('memory_write rejects an invalid kind (zod enum guard)', async () => {
  const res = (await client.callTool({
    name: 'memory_write',
    arguments: { title: 'Bad Kind', content: 'x', kind: 'whimsy' },
  })) as { isError?: boolean }
  assert.ok(res.isError, 'invalid kind must be rejected by the schema')
})

test('memory_search kinds filter over MCP returns only matching notes', async () => {
  await call('memory_write', { title: 'Decision Note', content: 'alpha beta gamma delta zeta', kind: 'decision', folder: 'memory' })
  await call('memory_write', { title: 'Log Note', content: 'alpha beta gamma delta zeta', kind: 'log', folder: 'memory' })
  const r = await call('memory_search', { query: 'alpha beta gamma', kinds: ['decision'] })
  assert.ok(r.length > 0)
  assert.ok(r.every((x: { notePath: string }) => x.notePath.startsWith('memory/')), 'all results in memory/')
})

test('memory_search pinned filter over MCP returns only pinned notes', async () => {
  await call('memory_write', { title: 'Pinned One', content: 'omega sigma tau phi chi psi', frontmatter: { pinned: true }, folder: 'memory' })
  const r = await call('memory_search', { query: 'omega sigma tau', pinned: true })
  assert.ok(r.length > 0, 'pinned filter must return the pinned note')
})

test('memory_list pinned filter over MCP returns only pinned notes', async () => {
  await call('memory_write', { title: 'Pinned List', content: 'pinnable', frontmatter: { pinned: true }, folder: 'inbox' })
  await call('memory_write', { title: 'Unpinned List', content: 'pinnable', folder: 'inbox' })
  const pinned = await call('memory_list', { folder: 'inbox', pinned: true })
  assert.ok(pinned.every((x: { path: string }) => x.path.startsWith('inbox/')))
  assert.ok(pinned.some((x: { title: string }) => x.title === 'Pinned List'))
  assert.ok(!pinned.some((x: { title: string }) => x.title === 'Unpinned List'))
})

test('memory_status reports topKinds when kind-tagged notes exist', async () => {
  await call('memory_write', { title: 'Status Decision', content: 'kappa lambda mu', kind: 'decision', folder: 'memory' })
  const s = await call('memory_status', {})
  assert.ok(Array.isArray(s.topKinds), 'topKinds is an array')
  if (s.topKinds.length) {
    for (const k of s.topKinds) {
      assert.equal(typeof k.kind, 'string')
      assert.ok(k.count > 0)
    }
    assert.ok(s.topKinds.some((k: { kind: string }) => k.kind === 'decision'), 'decision kind present')
  }
})

// ---- OME-12: per-client session watermark for memory_recent since:'lastSeen' ----

/** Spawn a fresh stdio serve on an isolated vault with a pinned OMEM_CLIENT_NAME. */
const spawnSeenClient = async (clientName: string) => {
  const v = mkdtempSync(join(tmpdir(), 'omem-seen-'))
  cpSync(FIXTURE, v, { recursive: true })
  const c = new Client({ name: `seen-${clientName}`, version: '0.0.0' })
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'src/cli.ts'), 'serve', '--vault', v, '--poll', '3600'],
      env: { ...process.env, OMEM_CLIENT_NAME: clientName },
      stderr: 'ignore',
    }),
  )
  return { c, v }
}

test('memory_recent since:"lastSeen": fresh client falls back to 24h and seeds the watermark', async () => {
  const { c, v } = await spawnSeenClient('client-A')
  try {
    // first call: no watermark yet -> fallback 24h, sinceResolved set, watermark seeded
    const r = await callOn(c, 'memory_recent', { since: 'lastSeen' })
    assert.equal(r.sinceResolved, 'fallback-24h')
    assert.ok(Array.isArray(r.notes))
    assert.ok(r.notes.length > 0, 'fixture notes (mtime ~= now) fall inside the 24h window')

    // second call: no changes since the seed -> empty, watermark advanced to an ISO
    const r2 = await callOn(c, 'memory_recent', { since: 'lastSeen' })
    assert.notEqual(r2.sinceResolved, 'fallback-24h')
    assert.ok(!Number.isNaN(Date.parse(r2.sinceResolved)), 'sinceResolved is now an ISO epoch')
    assert.equal(r2.notes.length, 0, 'no changes since the seed -> empty list')

    // write a note, then call again -> the new note appears, watermark advances again
    const w = await callOn(c, 'memory_write', { title: 'Watermark Probe', content: 'new since last seen', folder: 'memory' })
    const r3 = await callOn(c, 'memory_recent', { since: 'lastSeen' })
    assert.ok(r3.notes.some((n: { path: string }) => n.path === w.path), 'newly written note must appear as "changed since last seen"')

    // no further changes -> empty once more
    const r4 = await callOn(c, 'memory_recent', { since: 'lastSeen' })
    assert.equal(r4.notes.length, 0, 'watermark advanced past the new note -> empty')
  } finally {
    await c.close()
    rmSync(v, { recursive: true, force: true })
  }
})

test('memory_recent since:"lastSeen": different clients keep independent watermarks', async () => {
  // Client A seeds, writes a note, and drains to empty (watermark past the note).
  const a = await spawnSeenClient('client-A')
  // Client B on the SAME vault is fresh and must not inherit A's watermark.
  const bV = a.v
  const b = new Client({ name: 'seen-client-B', version: '0.0.0' })
  await b.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'src/cli.ts'), 'serve', '--vault', bV, '--poll', '3600'],
      env: { ...process.env, OMEM_CLIENT_NAME: 'client-B' },
      stderr: 'ignore',
    }),
  )
  try {
    await callOn(a.c, 'memory_recent', { since: 'lastSeen' }) // A seeds (fallback 24h)
    const w = await callOn(a.c, 'memory_write', { title: 'Shared Probe', content: 'only A should see this as new', folder: 'memory' })
    await callOn(a.c, 'memory_recent', { since: 'lastSeen' }) // A sees the note, watermark advances
    const aEmpty = await callOn(a.c, 'memory_recent', { since: 'lastSeen' })
    assert.equal(aEmpty.notes.length, 0, 'A has drained to empty')

    // B is fresh: fallback 24h, sees the note (and other recent notes), independent of A's watermark
    const bFirst = await callOn(b, 'memory_recent', { since: 'lastSeen' })
    assert.equal(bFirst.sinceResolved, 'fallback-24h', 'B is a fresh client — its own watermark, not A\'s')
    assert.ok(bFirst.notes.some((n: { path: string }) => n.path === w.path), 'B sees the note A wrote via its own fallback window')

    // B drains to empty independently
    const bSecond = await callOn(b, 'memory_recent', { since: 'lastSeen' })
    assert.equal(bSecond.notes.length, 0, 'B advanced its own watermark')
    // A is still empty — B's calls did not move A's watermark
    const aStill = await callOn(a.c, 'memory_recent', { since: 'lastSeen' })
    assert.equal(aStill.notes.length, 0, 'B\'s watermark activity must not affect A')
  } finally {
    await a.c.close()
    await b.close()
    rmSync(a.v, { recursive: true, force: true })
  }
})

test('memory_recent since:"1h"/"1d"/"7d" resolve to a rolling window without touching the watermark', async () => {
  const h = await call('memory_recent', { since: '1h', limit: 100 })
  const d = await call('memory_recent', { since: '1d', limit: 100 })
  const w = await call('memory_recent', { since: '7d', limit: 100 })
  for (const r of [h, d, w]) assert.ok(!Number.isNaN(Date.parse(r.sinceResolved)), 'sinceResolved must be an ISO epoch')
  // wider windows never exclude notes that narrower ones include
  assert.ok(w.notes.length >= d.notes.length, '7d ⊇ 1d')
  assert.ok(d.notes.length >= h.notes.length, '1d ⊇ 1h')
})
