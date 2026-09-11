import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDb } from '../src/db.ts'
import { fullIndex, embedPending } from '../src/indexer.ts'
import { search, recall } from '../src/search.ts'
import { isNavigationOnly, validCitation } from '../src/quality.ts'
import { memoryHealth } from '../src/health.ts'
import { checkDoctor } from '../src/doctor.ts'
import { buildToolCtx } from '../src/mcp/ctx.ts'
import { writeNote } from '../src/mcp/tools/write.ts'
import { decideLearn } from '../src/mcp/tools/learn.ts'
import { noteHash, commitNotes } from '../src/note-write.ts'
import { parseFrontmatter } from '../src/frontmatter.ts'
import { bow } from './helpers/bow.ts'
import { retrievalBenchmark } from './helpers/retrieval-benchmark.ts'

function fixture(t: { after: (fn: () => void) => void }) {
  const vault = mkdtempSync(join(tmpdir(), 'omem-quality-'))
  const db = openDb(':memory:')
  t.after(() => { db.close(); rmSync(vault, { recursive: true, force: true }) })
  const put = (path: string, raw: string) => {
    mkdirSync(dirname(join(vault, path)), { recursive: true })
    writeFileSync(join(vault, path), raw)
  }
  return { vault, db, put, ctx: buildToolCtx(db, vault, bow, () => 'quality-test') }
}

test('navigation detection preserves prose and code that happen to contain links', () => {
  for (const text of ['## Related\n- [[note|Topic]]', '# Index\n1. [API](https://example.com)', '# Empty'])
    assert.equal(isNavigationOnly(text), true, text)
  for (const text of ['Use [[Lease]] for safe coordination.', '## Related\n- [[note]] — Required before deployment.', '```ts\nconst link = "[[note]]"\n```'])
    assert.equal(isNavigationOnly(text), false, text)
})

test('archives are opt-in in keyword, vector, and graph legs, including metadata-only archives', async t => {
  const { put, db, vault } = fixture(t)
  put('active.md', 'uniquesync policy. [[archive/old]] [[hidden]]')
  put('archive/old.md', 'uniquesync obsolete policy')
  put('hidden.md', '---\narchived_at: 2026-01-01\n---\nuniquesync hidden policy')
  put('archivist.md', 'uniquesync normal policy')
  fullIndex(db, vault)
  await embedPending(db, bow)
  for (const embedder of [null, bow]) {
    const current = await search(db, 'uniquesync', { embedder })
    assert.ok(current.some(r => r.notePath === 'archivist.md'))
    assert.ok(current.every(r => !['archive/old.md', 'hidden.md'].includes(r.notePath)))
    const history = await search(db, 'uniquesync', { embedder, includeArchived: true })
    assert.ok(history.some(r => r.notePath === 'archive/old.md'))
    assert.ok(history.some(r => r.notePath === 'hidden.md'))
  }
  const packed = await recall(db, 'uniquesync', { includeArchived: true })
  assert.ok([...Object.values(packed.grouped).flat(), ...packed.related].some(r => r.notePath === 'archive/old.md'))
  assert.deepEqual(await search(db, 'uniquesync', { folder: 'archive' }), [])
})

test('archive exclusion applies to graph-only neighbors', async t => {
  const { put, db, vault } = fixture(t)
  put('seed.md', 'uniqueneedle [[archive/old]] [[hidden]] [[neighbor]]')
  put('archive/old.md', 'legacy content')
  put('hidden.md', '---\narchived_at: yesterday\n---\nhidden content')
  put('neighbor.md', 'neighbor content')
  fullIndex(db, vault)
  const results = await search(db, 'uniqueneedle')
  assert.deepEqual(results.map(r => r.notePath).sort(), ['neighbor.md', 'seed.md'])
})

test('recall respects its total limit and deduplicates unclassified notes', async t => {
  const { put, db, vault } = fixture(t)
  for (const [i, kind] of ['decision', 'gotcha', 'convention', 'fact', 'log', 'meeting'].entries())
    put(`${i}.md`, `---\nkind: ${kind}\n---\nsharedneedle answer ${i}`)
  put('related.md', '## First\nsharedneedle first answer\n## Second\nsharedneedle second answer')
  fullIndex(db, vault)
  for (const limit of [1, 2, 20]) {
    const r = await recall(db, 'sharedneedle', { limit })
    const notes = [...Object.values(r.grouped).flat(), ...r.related]
    assert.ok(notes.length <= limit)
    assert.equal(new Set(notes.map(n => n.notePath)).size, notes.length)
  }
})

test('budgeted recall includes links and bounds long UTF-8 excerpts without losing sources', async t => {
  const { put, db, vault, ctx } = fixture(t)
  put('long.md', `---\nkind: decision\n---\nbudgetneedle ${'Пример решения. '.repeat(3000)}`)
  fullIndex(db, vault)
  const r = await recall(db, 'budgetneedle', { maxTokens: 400, linkForPath: ctx.deepLink })
  const notes = [...Object.values(r.grouped).flat(), ...r.related]
  assert.equal(notes.length, 1)
  assert.equal(notes[0].notePath, 'long.md')
  assert.ok(notes[0].text.endsWith('…'))
  assert.equal(r.budget?.truncated, true)
  const linked = { ...r, grouped: Object.fromEntries(Object.entries(r.grouped).map(([k, v]) => [k, v.map(n => ({ ...n, link: ctx.deepLink(n.notePath) }))])) }
  assert.ok(Buffer.byteLength(JSON.stringify(linked)) / 3 <= 400)
  assert.ok(r.budget!.estimatedTokens <= 400)
  await assert.rejects(recall(db, 'budgetneedle', { maxTokens: 0 }), /maxTokens/)
  await assert.rejects(recall(db, 'budgetneedle '.repeat(500), { maxTokens: 256 }), /too small/)
})

test('updates preserve metadata and provenance, while hash checks reject stale edits', async t => {
  const { ctx, vault } = fixture(t)
  const first = await writeNote(ctx, { title: 'Answer', content: 'original body', frontmatter: { topic: 'ownership', source_url: 'https://example.com', source_version: '1', pinned: true }, tags: ['original'], kind: 'decision' })
  const before = parseFrontmatter(readFileSync(join(vault, first.path), 'utf8')).frontmatter
  const updates = await Promise.allSettled(['new body', 'conflicting body'].map(content => writeNote(ctx, { title: 'Answer', content, path: first.path, mode: 'update', expectedHash: first.hash, frontmatter: { confidence: 0.8, created: 'spoof' } })))
  assert.equal(updates.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(updates.filter(r => r.status === 'rejected').length, 1)
  const raw = readFileSync(join(vault, first.path), 'utf8')
  const note = parseFrontmatter(raw)
  assert.equal(note.frontmatter.created, before.created)
  assert.equal(note.frontmatter.source_url, before.source_url)
  assert.equal(note.frontmatter.topic, 'ownership')
  assert.equal(note.frontmatter.kind, 'decision')
  assert.deepEqual(note.frontmatter.tags, ['original'])
  assert.ok(note.content.includes('new body'))
  assert.ok(!note.content.includes('conflicting body'))
  for (const mode of ['append', 'overwrite'] as const)
    await assert.rejects(writeNote(ctx, { title: 'Answer', content: 'bad', path: first.path, mode, expectedHash: first.hash }), /note changed/)
  const overwritten = await writeNote(ctx, { title: 'Replacement', content: 'replaced', path: first.path, mode: 'overwrite', expectedHash: noteHash(raw) })
  assert.notEqual(overwritten.hash, first.hash)
  assert.equal(parseFrontmatter(readFileSync(join(vault, first.path), 'utf8')).frontmatter.topic, undefined)
})

test('out-of-range or nonnumeric confidence is rejected before any archive or write', async t => {
  const { ctx, vault } = fixture(t)
  const old = await writeNote(ctx, { title: 'Old', content: 'old' })
  for (const confidence of [-1, 2, '0.5', NaN])
    await assert.rejects(writeNote(ctx, { title: 'Invalid', content: 'invalid', frontmatter: { confidence }, supersedes: [old.path] }), /confidence/)
  assert.ok(existsSync(join(vault, old.path)))
})

test('decision history keeps bidirectional paths and default search excludes the predecessor', async t => {
  const { ctx, vault, db } = fixture(t)
  const old = await writeNote(ctx, { title: 'Old policy', content: 'historyneedle old policy', kind: 'decision' })
  const next = await writeNote(ctx, { title: 'New policy', content: 'historyneedle new policy because requirements changed', kind: 'decision', supersedes: [old.path] })
  const archivePath = next.superseded![0].to
  assert.equal(parseFrontmatter(readFileSync(join(vault, archivePath), 'utf8')).frontmatter.superseded_by, next.path)
  assert.deepEqual(parseFrontmatter(readFileSync(join(vault, next.path), 'utf8')).frontmatter.supersedes, [archivePath])
  assert.ok(!existsSync(join(vault, old.path)))
  assert.ok((await search(db, 'historyneedle')).every(r => r.notePath === next.path))
  assert.equal(memoryHealth(db).archivedWithoutReplacement.count, 0)
})

test('supersession prevalidates duplicate paths and archive collisions before modifying predecessors', async t => {
  const { ctx, vault, put } = fixture(t)
  const first = await writeNote(ctx, { title: 'First', content: 'original one' })
  const second = await writeNote(ctx, { title: 'Second', content: 'original two' })
  await assert.rejects(writeNote(ctx, { title: 'Duplicate', content: 'new', supersedes: [first.path, './' + first.path] }), /duplicate/)
  put('archive/' + second.path, 'existing archive')
  await assert.rejects(writeNote(ctx, { title: 'Collision', content: 'new', supersedes: [first.path, second.path] }), /archive target already exists/)
  assert.ok(existsSync(join(vault, first.path)))
  assert.ok(existsSync(join(vault, second.path)))
  assert.ok(!existsSync(join(vault, 'archive/' + first.path)))
})

test('ordinary publish failures restore previous files and index state', t => {
  const { put, db, vault } = fixture(t)
  put('first.md', 'original answer')
  put('blocked', 'not a directory')
  fullIndex(db, vault)
  assert.throws(() => commitNotes(db, vault, () => [
    { rel: 'first.md', abs: join(vault, 'first.md'), raw: 'changed answer' },
    { rel: 'blocked/second.md', abs: join(vault, 'blocked/second.md'), raw: 'cannot publish' },
  ]))
  assert.equal(readFileSync(join(vault, 'first.md'), 'utf8'), 'original answer')
  assert.equal((db.prepare('SELECT text FROM chunks WHERE note_path = ?').get('first.md') as { text: string }).text, 'original answer')
})

test('citation validation rejects placeholders, missing versions, and non-HTTP protocols', () => {
  for (const source_url of ['https://...', '<source URL>', 'file:///tmp/source', 'not a URL'])
    assert.equal(validCitation({ source_url, source_version: '1.0' }), false)
  for (const source_version of ['', 'latest', '<version>', null])
    assert.equal(validCitation({ source_url: 'https://example.com/docs', source_version }), false)
  assert.equal(validCitation({ source_url: 'https://example.com/docs#topic', source_version: '2026-09-11' }), true)
})

test('three citations alone cannot satisfy scope readiness', () => {
  const args = { topic: 'HTTP', island: 'islands/docs-http', cited: 3, coverage: { notes: 3, byFolder: {}, bySubtopic: {}, byKind: {}, sourceVersions: [], sourceVersionCount: 0 } }
  assert.equal(decideLearn(args).status, 'incomplete')
  const partial = decideLearn({ ...args, scopeMatches: true, hubComplete: true, questions: [{ question: 'How do retries work?', answered: false }] })
  assert.deepEqual(partial.unansweredQuestions, ['How do retries work?'])
  assert.equal(partial.evidenceStatus, 'minimum-present')
  assert.equal(partial.status, 'incomplete')
  assert.equal(decideLearn({ ...args, scopeMatches: true, hubComplete: true, questions: [{ question: 'How do retries work?', answered: true }] }).status, 'ready')
})

test('health audit reports bounded, read-only knowledge findings', t => {
  const { put, db, vault } = fixture(t)
  const body = 'A detailed fact about a project configuration that is long enough to compare duplicate note bodies without guessing semantics.'
  put('stale.md', `---\nverified_at: '2020-01-01'\n---\n${body}`)
  put('duplicate.md', body)
  put('future.md', "---\nverified_at: '2020-01-01'\nreview_after: '2030-01-01'\n---\nReviewed according to an explicit schedule.")
  put('archive/old.md', '---\nkind: decision\n---\nold advice')
  for (let i = 0; i < 25; i++) put(`islands/docs-http/${i}.md`, `uncited fact ${i} [[missing-${i}]]`)
  fullIndex(db, vault)
  const before = db.prepare('SELECT * FROM notes ORDER BY path').all()
  const report = memoryHealth(db, Date.parse('2026-09-11'))
  assert.equal(report.stale.count, 1)
  assert.equal(report.missingCitations.count, 25)
  assert.equal(report.missingCitations.items.length, 20)
  assert.equal(report.brokenLinks.count, 25)
  assert.equal(report.possibleDuplicates.count, 1)
  assert.equal(report.archivedWithoutReplacement.count, 1)
  assert.deepEqual(db.prepare('SELECT * FROM notes ORDER BY path').all(), before)
})

test('doctor does not create an index in an unindexed vault', async t => {
  const { vault } = fixture(t)
  const r = await checkDoctor(vault)
  assert.equal(r.db, false)
  assert.equal(r.health, null)
  assert.equal(existsSync(join(vault, '.omem')), false)
})

test('curated retrieval benchmark keeps answer notes first and excludes archived guidance', async () => {
  const report = await retrievalBenchmark()
  for (const result of report.modes) {
    assert.equal(result.top1, result.queries)
    assert.equal(result.top5, result.queries)
    assert.equal(result.archivedResults, 0)
    if (result.mode === 'hybrid') assert.equal(result.navigationResults, 0)
  }
})

test('successive decisions preserve the full predecessor chain after archiving', async t => {
  const { ctx, vault, db } = fixture(t)
  const a = await writeNote(ctx, { title: 'Policy A', content: 'First decision.', kind: 'decision' })
  const b = await writeNote(ctx, { title: 'Policy B', content: 'Second decision.', kind: 'decision', supersedes: [a.path] })
  const c = await writeNote(ctx, { title: 'Policy C', content: 'Third decision.', kind: 'decision', supersedes: [b.path] })
  const read = (p: string) => parseFrontmatter(readFileSync(join(vault, p), 'utf8')).frontmatter
  const archivedA = b.superseded![0].to
  const archivedB = c.superseded![0].to
  assert.equal(read(archivedA).superseded_by, archivedB)
  assert.equal(read(archivedB).superseded_by, c.path)
  assert.deepEqual(read(archivedB).supersedes, [archivedA])
  assert.deepEqual(read(c.path).supersedes, [archivedB])
  assert.equal(memoryHealth(db).archivedWithoutReplacement.count, 0)
  const archivedC = await ctx.archiveNote(c.path, 'Retired without replacement')
  assert.equal(read(archivedB).superseded_by, archivedC.to)
  assert.equal(memoryHealth(db).archivedWithoutReplacement.count, 1)
})

test('hash checks serialize writers in separate processes sharing one index', async t => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const run = promisify(execFile)
  const { vault } = fixture(t)
  const db = openDb(join(vault, '.omem', 'index.db'))
  t.after(() => db.close())
  const ctx = buildToolCtx(db, vault, bow, () => 'parent')
  const original = await writeNote(ctx, { title: 'Concurrent note', content: 'Before either update.' })
  const results = await Promise.allSettled(['Writer one.', 'Writer two.'].map(content => run(process.execPath, [
    fileURLToPath(new URL('./helpers/write-worker.ts', import.meta.url)), vault, original.path, original.hash, content,
  ])))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.match(String(rejected.reason.stderr), /note changed/)
  const successful = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ stdout: string }>
  assert.equal(noteHash(readFileSync(join(vault, original.path), 'utf8')), JSON.parse(successful.value.stdout).hash)
})
