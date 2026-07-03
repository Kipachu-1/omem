import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type DB } from '../src/db.ts'
import { fullIndex, embedPending } from '../src/indexer.ts'
import { search } from '../src/search.ts'
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
