import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type DB } from '../src/db.ts'
import { fullIndex, indexFile, deleteNote } from '../src/indexer.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/vault', import.meta.url))

let vault: string
let db: DB

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'omem-vault-'))
  cpSync(FIXTURE, vault, { recursive: true })
  db = openDb(':memory:')
  fullIndex(db, vault)
})

afterEach(() => {
  db.close()
  rmSync(vault, { recursive: true, force: true })
})

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n

test('full index: counts and consistency', () => {
  assert.equal(count('SELECT count(*) n FROM notes'), 18)
  assert.ok(count('SELECT count(*) n FROM chunks') > 18, 'multi-chunk notes exist')
  assert.equal(
    count('SELECT count(*) n FROM chunks'),
    count('SELECT count(*) n FROM chunks_fts'),
    'fts mirrors chunks',
  )
  assert.equal(count("SELECT count(*) n FROM notes WHERE path = 'notes/empty.md'"), 1)
  assert.equal(count("SELECT count(*) n FROM chunks WHERE note_path = 'notes/empty.md'"), 0)
})

test('wikilinks resolve across folders, by title and alias; missing target unresolved', () => {
  const edges = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'projects/canvas.md' AND type = 'wikilink' ORDER BY dst").all() as { dst: string; resolved: number }[]
  assert.deepEqual(edges, [
    { dst: 'Future Note', resolved: 0 },
    { dst: 'notes/gpu-profiling.md', resolved: 1 }, // via title "GPU Profiling"
    { dst: 'people/bob-smith.md', resolved: 1 }, // via alias [[Bob Smith|Bobby]]
  ])
})

test('unresolved link heals when target note is created', () => {
  writeFileSync(join(vault, 'notes/future-note.md'), '---\ntitle: Future Note\n---\nNow I exist.')
  indexFile(db, vault, 'notes/future-note.md')
  const edge = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'projects/canvas.md' AND dst = 'notes/future-note.md'").get() as { resolved: number }
  assert.equal(edge.resolved, 1)
  assert.equal(count("SELECT count(*) n FROM edges WHERE src_path = 'projects/canvas.md' AND dst = 'Future Note'"), 0)
})

test('re-index unchanged file is a no-op; changed file replaces chunks', () => {
  assert.equal(indexFile(db, vault, 'notes/alpha.md'), false)
  const before = count("SELECT count(*) n FROM chunks WHERE note_path = 'notes/alpha.md'")
  writeFileSync(join(vault, 'notes/alpha.md'), '# New\n\nchanged body\n\n# Second\n\nmore')
  assert.equal(indexFile(db, vault, 'notes/alpha.md'), true)
  assert.equal(count("SELECT count(*) n FROM chunks WHERE note_path = 'notes/alpha.md'"), 2)
  assert.notEqual(before, 2)
  assert.equal(count('SELECT count(*) n FROM chunks'), count('SELECT count(*) n FROM chunks_fts'))
})

test('delete note: cascades, incoming links revert to raw target, heal on re-create', () => {
  deleteNote(db, 'people/bob-smith.md')
  assert.equal(count("SELECT count(*) n FROM chunks WHERE note_path = 'people/bob-smith.md'"), 0)
  const e = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'projects/canvas.md' AND raw = 'Bob Smith'").get() as { dst: string; resolved: number }
  assert.deepEqual(e, { dst: 'Bob Smith', resolved: 0 })
  writeFileSync(join(vault, 'people/bob-smith.md'), '---\ntitle: Bob Smith\n---\nHe is back.')
  indexFile(db, vault, 'people/bob-smith.md')
  const e2 = db.prepare("SELECT resolved FROM edges WHERE src_path = 'projects/canvas.md' AND dst = 'people/bob-smith.md'").get() as { resolved: number }
  assert.equal(e2.resolved, 1)
})

test('file removed from disk is removed on next full index', () => {
  unlinkSync(join(vault, 'notes/gamma.md'))
  const s = fullIndex(db, vault)
  assert.equal(s.removed, 1)
  assert.equal(count("SELECT count(*) n FROM notes WHERE path = 'notes/gamma.md'"), 0)
})

test('rebuild equals incremental', () => {
  // mutate: change one, add one, delete one — then incrementally sync
  writeFileSync(join(vault, 'notes/alpha.md'), 'totally new alpha content with [[Beta]]')
  writeFileSync(join(vault, 'notes/new-note.md'), '# Fresh\n\nnew note here')
  unlinkSync(join(vault, 'notes/delta.md'))
  fullIndex(db, vault)

  const fresh = openDb(':memory:')
  fullIndex(fresh, vault)

  const dump = (d: DB) => ({
    notes: d.prepare('SELECT path, title, hash FROM notes ORDER BY path').all(),
    chunks: d.prepare('SELECT note_path, heading, position, text FROM chunks ORDER BY note_path, position').all(),
    edges: d.prepare('SELECT src_path, dst, type, resolved FROM edges ORDER BY src_path, dst, type').all(),
  })
  assert.deepEqual(dump(db), dump(fresh))
  fresh.close()
})

test('hub note caps: all 8 links resolve', () => {
  assert.equal(count("SELECT count(*) n FROM edges WHERE src_path = 'notes/hub.md' AND type = 'wikilink' AND resolved = 1"), 8)
})

const dumpAll = (d: DB) => ({
  notes: d.prepare('SELECT path, title, hash FROM notes ORDER BY path').all(),
  chunks: d.prepare('SELECT note_path, heading, position, text FROM chunks ORDER BY note_path, position').all(),
  edges: d.prepare('SELECT src_path, dst, type, resolved, raw FROM edges ORDER BY src_path, dst, type').all(),
})
const assertConverged = (d: DB, v: string) => {
  const fresh = openDb(':memory:')
  fullIndex(fresh, v)
  assert.deepEqual(dumpAll(d), dumpAll(fresh))
  fresh.close()
}

test('rename keeping title: incoming links follow to the new path, converges', () => {
  const content = '---\ntitle: Bob Smith\n---\nBackend engineer.'
  unlinkSync(join(vault, 'people/bob-smith.md'))
  writeFileSync(join(vault, 'people/robert.md'), content)
  fullIndex(db, vault)
  const e = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'projects/canvas.md' AND raw = 'Bob Smith'").get() as { dst: string; resolved: number }
  assert.deepEqual(e, { dst: 'people/robert.md', resolved: 1 })
  assertConverged(db, vault)
})

test('title change: links resolved via the old title unresolve, converges', () => {
  writeFileSync(join(vault, 'notes/gpu-profiling.md'), '---\ntitle: GPU Perf\n---\nrenamed title\n\n## Tools\nstuff')
  fullIndex(db, vault)
  const e = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'projects/canvas.md' AND raw = 'GPU Profiling'").get() as { dst: string; resolved: number }
  assert.deepEqual(e, { dst: 'GPU Profiling', resolved: 0 })
  assertConverged(db, vault)
})

test('better candidate appears: exact-path match steals a title-based resolution, converges', () => {
  writeFileSync(join(vault, 'Coding Style.md'), 'The real deal at the vault root.')
  fullIndex(db, vault)
  const e = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'memory/2026-06-28-prefers-spaces.md' AND raw = 'Coding Style'").get() as { dst: string; resolved: number }
  assert.deepEqual(e, { dst: 'Coding Style.md', resolved: 1 })
  assertConverged(db, vault)
})

test('delete with a second candidate: incoming links re-resolve to next-best, converges', () => {
  writeFileSync(join(vault, 'notes/dup.md'), 'first dup')
  writeFileSync(join(vault, 'projects/dup.md'), 'second dup')
  writeFileSync(join(vault, 'notes/linker.md'), 'points at [[dup]]')
  fullIndex(db, vault)
  const e1 = db.prepare("SELECT dst FROM edges WHERE src_path = 'notes/linker.md' AND raw = 'dup'").get() as { dst: string }
  assert.equal(e1.dst, 'notes/dup.md')
  unlinkSync(join(vault, 'notes/dup.md'))
  fullIndex(db, vault)
  const e2 = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'notes/linker.md' AND raw = 'dup'").get() as { dst: string; resolved: number }
  assert.deepEqual(e2, { dst: 'projects/dup.md', resolved: 1 })
  assertConverged(db, vault)
})

test('multi-segment link target heals via path suffix, converges', () => {
  writeFileSync(join(vault, 'notes/deep-linker.md'), 'see [[projects/canvas]] and [[archive/old-thing]]')
  fullIndex(db, vault)
  const ok = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'notes/deep-linker.md' AND raw = 'projects/canvas'").get() as { dst: string; resolved: number }
  assert.deepEqual(ok, { dst: 'projects/canvas.md', resolved: 1 })
  mkdirSync(join(vault, 'archive'))
  writeFileSync(join(vault, 'archive/old-thing.md'), 'appears later')
  fullIndex(db, vault)
  const healed = db.prepare("SELECT dst, resolved FROM edges WHERE src_path = 'notes/deep-linker.md' AND raw = 'archive/old-thing'").get() as { dst: string; resolved: number }
  assert.deepEqual(healed, { dst: 'archive/old-thing.md', resolved: 1 })
  assertConverged(db, vault)
})

test('1k-note vault: fullIndex converges (incremental == rebuild) and exercises reResolve at scale', () => {
  const big = mkdtempSync(join(tmpdir(), 'omem-big-'))
  try {
    // 1000 notes across 10 folders, each linking to a few others by basename and
    // title — every one triggers a reResolve pass, the O(n²) hot path this fixes.
    for (let f = 0; f < 10; f++) {
      mkdirSync(join(big, `folder${f}`), { recursive: true })
      for (let n = 0; n < 100; n++) {
        const targetA = `folder${(f + 1) % 10}/note${(n + 1) % 100}`
        const targetB = `folder${(f + 2) % 10}/note${(n + 7) % 100}`
        writeFileSync(
          join(big, `folder${f}`, `note${n}.md`),
          `---\ntitle: Note ${f}-${n}\n---\nlinks: [[${targetA}]] [[${targetB}]] [[Note ${f}-${n}]]\n`,
        )
      }
    }
    const t0 = Date.now()
    fullIndex(db, big)
    const elapsed = Date.now() - t0
    // a note also links to its own title ([[Note f-n]]) — proves the title-match
    // branch of the candidate query is exercised at scale.
    assert.equal(count('SELECT count(*) n FROM notes'), 1000)

    const fresh = openDb(':memory:')
    fullIndex(fresh, big)
    const dump = (d: DB) => ({
      notes: d.prepare('SELECT path, title, hash FROM notes ORDER BY path').all(),
      edges: d.prepare('SELECT src_path, dst, type, resolved, raw FROM edges ORDER BY src_path, dst, type, raw').all(),
    })
    assert.deepEqual(dump(db), dump(fresh), 'incremental == rebuild invariant holds at 1k notes')
    fresh.close()
    // soft timing log for manual perf inspection (no hard assertion — flaky in CI)
    console.log(`  1k-note fullIndex + reResolve: ${elapsed}ms`)
  } finally {
    rmSync(big, { recursive: true, force: true })
  }
})
