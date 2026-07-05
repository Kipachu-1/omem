import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type DB } from '../src/db.ts'
import { fullIndex, embedPending } from '../src/indexer.ts'
import { search, recall, noteMeta } from '../src/search.ts'
import type { Embedder } from '../src/embed.ts'

// deterministic bag-of-words embedder: real similarity behavior, no model download
const fake: Embedder = {
  model: 'fake-bow',
  async embed(texts) {
    return texts.map(t => {
      const v = new Float32Array(64)
      for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let h = 5381
        for (const ch of w) h = (h * 33 + ch.codePointAt(0)!) >>> 0
        v[h % 64] += 1
      }
      const n = Math.hypot(...v) || 1
      for (let i = 0; i < v.length; i++) v[i] /= n
      return v
    })
  },
}

const FIXTURE = fileURLToPath(new URL('./fixtures/vault', import.meta.url))

let vault: string
let db: DB

before(async () => {
  vault = mkdtempSync(join(tmpdir(), 'omem-search-'))
  cpSync(FIXTURE, vault, { recursive: true })
  // recency fixture: old memory is 60 days stale, new one fresh
  const old = new Date(Date.now() - 60 * 86_400_000)
  utimesSync(join(vault, 'memory/2026-06-28-prefers-spaces.md'), old, old)
  db = openDb(':memory:')
  fullIndex(db, vault)
  await embedPending(db, fake)
})

after(() => {
  db.close()
  rmSync(vault, { recursive: true, force: true })
})

test('hybrid: chunk matching both legs ranks first as "both"', async () => {
  const r = await search(db, 'canvas rendering performance', { embedder: fake })
  assert.ok(r.length > 0)
  assert.equal(r[0].notePath, 'projects/canvas.md')
  assert.equal(r[0].matchType, 'both')
})

test('graph expansion: note reachable only via wikilink appears as "graph"', async () => {
  // bob-smith shares no vocabulary with the query; only [[Bob Smith|Bobby]] from canvas.md reaches it
  const r = await search(db, 'canvas rendering performance', { embedder: null })
  const bob = r.find(x => x.notePath === 'people/bob-smith.md')
  assert.ok(bob, 'graph expansion should surface the linked note')
  assert.equal(bob.matchType, 'graph')
  const canvas = r.find(x => x.notePath === 'projects/canvas.md')
  assert.ok(canvas && canvas.score > bob.score, 'graph hits are discounted below their seed')
})

test('graph expansion off: linked-only note absent', async () => {
  const r = await search(db, 'canvas rendering performance', { embedder: null, expandGraph: false })
  assert.equal(r.find(x => x.notePath === 'people/bob-smith.md'), undefined)
})

test('hub expansion respects per-seed cap', async () => {
  const r = await search(db, 'hubword', { embedder: null })
  const graph = r.filter(x => x.matchType === 'graph')
  assert.ok(graph.length <= 5, `per-seed cap: got ${graph.length}`)
  assert.ok(graph.length > 0, 'hub should expand to some neighbors')
})

test('folder filter excludes other folders including graph additions', async () => {
  const r = await search(db, 'canvas rendering performance', { embedder: fake, folder: 'projects' })
  assert.ok(r.length > 0)
  for (const x of r) assert.ok(x.notePath.startsWith('projects/'), x.notePath)
})

test('tag filter, including nested tag prefix', async () => {
  const r = await search(db, 'relevance search engine', { embedder: fake, tags: ['project'] })
  assert.ok(r.length > 0)
  for (const x of r) assert.ok(x.notePath.startsWith('projects/'), x.notePath)
})

test('per-note cap: a long note cannot flood results', async () => {
  const r = await search(db, 'bigword topic', { embedder: fake, expandGraph: false })
  const big = r.filter(x => x.notePath === 'notes/big-note.md')
  assert.ok(big.length >= 1 && big.length <= 2, `got ${big.length}`)
})

test('recency: fresher memory outranks stale near-identical memory', async () => {
  const r = await search(db, 'indentation', { embedder: null })
  const newer = r.findIndex(x => x.notePath === 'memory/2026-07-01-prefers-tabs.md')
  const older = r.findIndex(x => x.notePath === 'memory/2026-06-28-prefers-spaces.md')
  assert.ok(newer !== -1 && older !== -1)
  assert.ok(newer < older, `newer memory should rank first (newer=${newer}, older=${older})`)
})

test('keyword-only mode works without any embeddings', async () => {
  const r = await search(db, 'quokkas', { embedder: null })
  assert.equal(r[0]?.notePath, 'notes/no-heading.md')
  assert.equal(r[0]?.matchType, 'keyword')
})

test('cyrillic content is searchable', async () => {
  const r = await search(db, 'производительность рендеринга', { embedder: fake })
  assert.ok(r.some(x => x.notePath === 'notes/unicode.md'))
})

test('fts syntax characters in query do not throw', async () => {
  const r = await search(db, 'weird "AND (query* NEAR/3', { embedder: null })
  assert.ok(Array.isArray(r))
})

test('no matches returns empty, not error', async () => {
  const r = await search(db, 'zzzzzz qqqqqq', { embedder: null })
  assert.deepEqual(r, [])
})

test('filters with zero matching notes return empty fast', async () => {
  const r = await search(db, 'canvas', { embedder: fake, folder: 'nonexistent' })
  assert.deepEqual(r, [])
})

test('after filter excludes notes older than the threshold', async () => {
  // 60-day-old memory note is excluded by a 1-day-ago cutoff; fresh memory note stays
  const r = await search(db, 'indentation', { embedder: null, after: Date.now() - 86_400_000 })
  assert.ok(!r.some(x => x.notePath === 'memory/2026-06-28-prefers-spaces.md'), 'stale note excluded by after')
  assert.ok(r.some(x => x.notePath === 'memory/2026-07-01-prefers-tabs.md'), 'fresh note kept by after')
})

test('before filter excludes notes newer than the threshold', async () => {
  // a cutoff 30 days ago excludes the fresh note but keeps the 60-day-old one
  const r = await search(db, 'indentation', { embedder: null, before: Date.now() - 30 * 86_400_000 })
  assert.ok(!r.some(x => x.notePath === 'memory/2026-07-01-prefers-tabs.md'), 'fresh note excluded by before')
  assert.ok(r.some(x => x.notePath === 'memory/2026-06-28-prefers-spaces.md'), 'stale note kept by before')
})

test('after + before window returns only notes inside the window', async () => {
  // window [now-70d, now-50d] contains the 60-day-old note but not the fresh one
  const r = await search(db, 'indentation', {
    embedder: null,
    after: Date.now() - 70 * 86_400_000,
    before: Date.now() - 50 * 86_400_000,
  })
  assert.ok(r.some(x => x.notePath === 'memory/2026-06-28-prefers-spaces.md'), '60d-old note inside window')
  assert.ok(!r.some(x => x.notePath === 'memory/2026-07-01-prefers-tabs.md'), 'fresh note outside window')
})

// --- recall: kind bucketing (delegates filtering/boost to search, reads notes.kind/pinned columns) ---

function writeKindNote(kind: string, title: string, pinned: boolean, body: string): string {
  const path = `memory/${kind}-${title.replace(/\s+/g, '-').toLowerCase()}.md`
  const fm = `---\ntitle: ${title}\nkind: ${kind}${pinned ? '\npinned: true' : ''}\n---\n`
  writeFileSync(join(vault, path), `${fm}\n${body}\n`)
  return path
}

test('noteMeta reads kind/pinned from the notes columns', () => {
  const a = writeKindNote('decision', 'Recall Decision A', true, 'numbat release needs the pouch checklist')
  const b = writeKindNote('log', 'Recall Log B', false, 'numbat release ran today, nothing notable')
  fullIndex(db, vault)
  const m = noteMeta(db, [a, b, 'notes/missing.md'])
  assert.equal(m.get(a)?.kind, 'decision')
  assert.equal(m.get(a)?.pinned, 1)
  assert.equal(m.get(b)?.kind, 'log')
  assert.equal(m.get(b)?.pinned, 0)
  assert.equal(m.get('notes/missing.md'), undefined, 'missing paths absent from the map')
})

test('recall groups results by kind and boosts pinned decisions above logs (keyword-only)', async () => {
  const dPin = writeKindNote('decision', 'Recall Decision Pinned', true, 'wombat deploy decision pinned body')
  const dPlain = writeKindNote('decision', 'Recall Decision Plain', false, 'wombat deploy decision plain body')
  const lg = writeKindNote('log', 'Recall Log Plain', false, 'wombat deploy log plain body')
  fullIndex(db, vault)

  const r = await recall(db, 'wombat deploy', { embedder: null })
  assert.equal(r.query, 'wombat deploy')
  assert.equal(r.grouped.decision.length, 2, `expected 2 decisions, got ${r.grouped.decision.length}`)
  assert.ok(r.grouped.log.length >= 1, 'log bucket populated')
  assert.equal(r.grouped.decision[0].notePath, dPin, 'pinned decision ranks first within its bucket')
  for (const k of ['decision', 'gotcha', 'convention', 'fact', 'meeting', 'log'])
    assert.ok(Array.isArray(r.grouped[k]), `grouped.${k} must be an array`)
  assert.equal(typeof r.totalScanned, 'number')
  // log note is not miscategorized into the decision bucket
  assert.ok(!r.grouped.decision.some((x: { notePath: string }) => x.notePath === lg), 'log must not appear in grouped.decision')
})

test('recall kinds filter restricts to requested buckets', async () => {
  const r = await recall(db, 'wombat deploy', { embedder: null, kinds: ['log'] })
  assert.ok(r.grouped.log.length > 0, 'log bucket populated under kinds filter')
  assert.equal(r.grouped.decision.length, 0, 'decision bucket empty under kinds:["log"]')
})

test('recall pinnedOnly returns only pinned notes', async () => {
  const r = await recall(db, 'wombat deploy', { embedder: null, pinnedOnly: true })
  const all = [...r.grouped.decision, ...r.grouped.log, ...r.related]
  assert.ok(all.length > 0, 'pinnedOnly must return the pinned decision')
  for (const x of all)
    assert.equal(x.notePath, 'memory/decision-recall-decision-pinned.md', `only pinned note expected, got ${x.notePath}`)
})
