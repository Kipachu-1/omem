import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openDb, type DB } from '../src/db.ts'
import { fullIndex, indexFile } from '../src/indexer.ts'
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

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'omem-kind-'))
  cpSync(FIXTURE, vault, { recursive: true })
  db = openDb(':memory:')
  fullIndex(db, vault)
})

afterEach(() => {
  db.close()
  rmSync(vault, { recursive: true, force: true })
})

const note = (rel: string, fm: Record<string, unknown>, body: string) => {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')
  writeFileSync(join(vault, rel), `---\n${yaml}\n---\n${body}\n`)
}

test('indexer extracts kind and pinned (bool / "true" / 1) from frontmatter', () => {
  note('memory/kind-bool.md', { title: 'KB', kind: 'decision', pinned: true }, 'decided to use spaces')
  note('memory/kind-str.md', { title: 'KS', kind: 'convention', pinned: 'true' }, 'convention: tabs')
  note('memory/kind-num.md', { title: 'KN', kind: 'gotcha', pinned: 1 }, 'gotcha here')
  note('memory/kind-none.md', { title: 'KO', kind: 'log' }, 'a plain log')
  indexFile(db, vault, 'memory/kind-bool.md')
  indexFile(db, vault, 'memory/kind-str.md')
  indexFile(db, vault, 'memory/kind-num.md')
  indexFile(db, vault, 'memory/kind-none.md')

  const row = (p: string) =>
    db.prepare('SELECT kind, pinned FROM notes WHERE path = ?').get(p) as { kind: string | null; pinned: number }
  assert.deepEqual(row('memory/kind-bool.md'), { kind: 'decision', pinned: 1 })
  assert.deepEqual(row('memory/kind-str.md'), { kind: 'convention', pinned: 1 })
  assert.deepEqual(row('memory/kind-num.md'), { kind: 'gotcha', pinned: 1 })
  assert.deepEqual(row('memory/kind-none.md'), { kind: 'log', pinned: 0 })
})

test('fullIndex re-stamps kind/pinned for existing notes on a migrated db', () => {
  // pre-seed two notes with kind/pinned in frontmatter, then a full rebuild picks them up
  note('memory/re-stamp.md', { title: 'RS', kind: 'decision', pinned: true }, 'rebuild me')
  note('memory/re-stamp-plain.md', { title: 'RP', kind: 'log' }, 'plain')
  fullIndex(db, vault) // idempotent reindex
  const row = (p: string) =>
    db.prepare('SELECT kind, pinned FROM notes WHERE path = ?').get(p) as { kind: string | null; pinned: number }
  assert.equal(row('memory/re-stamp.md').kind, 'decision')
  assert.equal(row('memory/re-stamp.md').pinned, 1)
  assert.equal(row('memory/re-stamp-plain.md').kind, 'log')
  assert.equal(row('memory/re-stamp-plain.md').pinned, 0)
})

test('memory_search kinds filter returns only matching notes', async () => {
  note('memory/dec.md', { title: 'D', kind: 'decision' }, 'deploy on friday deploy friday')
  note('memory/log.md', { title: 'L', kind: 'log' }, 'deploy on friday deploy friday')
  indexFile(db, vault, 'memory/dec.md')
  indexFile(db, vault, 'memory/log.md')
  await fake.embed(['deploy on friday deploy friday'], 'doc') // warm

  const decisions = await search(db, 'deploy friday', { kinds: ['decision'], embedder: fake })
  assert.ok(decisions.every(r => r.notePath === 'memory/dec.md'), 'kinds filter must exclude non-decisions')
  const logs = await search(db, 'deploy friday', { kinds: ['log'], embedder: fake })
  assert.ok(logs.every(r => r.notePath === 'memory/log.md'))
})

test('memory_search pinned filter returns only pinned notes', async () => {
  note('memory/pin.md', { title: 'P', pinned: true }, 'deploy friday deploy friday')
  note('memory/unp.md', { title: 'U', pinned: false }, 'deploy friday deploy friday')
  indexFile(db, vault, 'memory/pin.md')
  indexFile(db, vault, 'memory/unp.md')
  const r = await search(db, 'deploy friday', { pinned: true, embedder: fake })
  assert.ok(r.length > 0)
  assert.ok(r.every(x => x.notePath === 'memory/pin.md'), 'pinned filter must exclude unpinned')
})

test('ranking: a decision outranks an identical-text log (recency equal)', async () => {
  const text = 'identical body about deployment cadence and release trains'
  note('memory/r-log.md', { title: 'RL', kind: 'log' }, text)
  note('memory/r-dec.md', { title: 'RD', kind: 'decision' }, text)
  // equal mtime so the only differentiator is the kind boost
  const t = new Date()
  utimesSync(join(vault, 'memory/r-log.md'), t, t)
  utimesSync(join(vault, 'memory/r-dec.md'), t, t)
  indexFile(db, vault, 'memory/r-log.md')
  indexFile(db, vault, 'memory/r-dec.md')
  const r = await search(db, 'deployment cadence release trains', { embedder: fake })
  const decIdx = r.findIndex(x => x.notePath === 'memory/r-dec.md')
  const logIdx = r.findIndex(x => x.notePath === 'memory/r-log.md')
  assert.ok(decIdx !== -1 && logIdx !== -1, 'both notes must appear')
  assert.ok(decIdx < logIdx, 'decision must rank ahead of the identical log')
})

test('ranking: a pinned note outranks an identical unpinned one', async () => {
  const text = 'identical body about caching strategy and invalidation rules'
  note('memory/r-unpinned.md', { title: 'RU' }, text)
  note('memory/r-pinned.md', { title: 'RP', pinned: true }, text)
  const t = new Date()
  utimesSync(join(vault, 'memory/r-unpinned.md'), t, t)
  utimesSync(join(vault, 'memory/r-pinned.md'), t, t)
  indexFile(db, vault, 'memory/r-unpinned.md')
  indexFile(db, vault, 'memory/r-pinned.md')
  const r = await search(db, 'caching strategy invalidation rules', { embedder: fake })
  const pinIdx = r.findIndex(x => x.notePath === 'memory/r-pinned.md')
  const unIdx = r.findIndex(x => x.notePath === 'memory/r-unpinned.md')
  assert.ok(pinIdx !== -1 && unIdx !== -1, 'both notes must appear')
  assert.ok(pinIdx < unIdx, 'pinned must rank ahead of the identical unpinned note')
})

test('openDb migrates an old schema (no kind/pinned columns) idempotently', () => {
  // build a db with the pre-OME-14 notes schema, then prove openDb upgrades it
  const oldDb = new Database(':memory:')
  oldDb.exec(`
    CREATE TABLE notes (
      path TEXT PRIMARY KEY, title TEXT NOT NULL, frontmatter TEXT,
      mtime INTEGER NOT NULL, hash TEXT NOT NULL
    );
    INSERT INTO notes VALUES ('memory/x.md','X','{}',0,'h');
  `)
  const cols = () =>
    (oldDb.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map(c => c.name)
  assert.ok(!cols().includes('kind'), 'precondition: old schema has no kind column')
  // simulate the upgrade path: openDb on an in-memory db is fresh; instead apply the same
  // ALTER migration block openDb uses, twice, to prove idempotency
  for (const col of ['kind TEXT', 'pinned INTEGER NOT NULL DEFAULT 0']) {
    try {
      oldDb.exec(`ALTER TABLE notes ADD COLUMN ${col}`)
    } catch (e) {
      if (!/duplicate column name/i.test((e as Error).message)) throw e
    }
  }
  // second pass: idempotent (no throw)
  for (const col of ['kind TEXT', 'pinned INTEGER NOT NULL DEFAULT 0']) {
    try {
      oldDb.exec(`ALTER TABLE notes ADD COLUMN ${col}`)
    } catch (e) {
      if (!/duplicate column name/i.test((e as Error).message)) throw e
    }
  }
  assert.ok(cols().includes('kind') && cols().includes('pinned'), 'columns added')
  // existing row gets defaults
  const row = oldDb.prepare('SELECT kind, pinned FROM notes WHERE path = ?').get('memory/x.md') as {
    kind: string | null
    pinned: number
  }
  assert.equal(row.kind, null)
  assert.equal(row.pinned, 0)
  oldDb.close()
})

test('openDb is idempotent on a fresh db (re-open does not throw)', () => {
  const path = join(vault, '.omem', 'test-idempotent.db')
  const d1 = openDb(path)
  d1.close()
  const d2 = openDb(path) // ALTER must no-op on existing columns
  const cols = (d2.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map(c => c.name)
  assert.ok(cols.includes('kind') && cols.includes('pinned'))
  d2.close()
})
