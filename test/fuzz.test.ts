import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, renameSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../src/db.ts'
import { fullIndex } from '../src/indexer.ts'

// property: after ANY sequence of vault mutations, incremental fullIndex
// converges to exactly the DB a from-scratch rebuild would produce

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dump = (d: DB) => ({
  notes: d.prepare('SELECT path, title, hash FROM notes ORDER BY path').all(),
  chunks: d.prepare('SELECT note_path, heading, position, text FROM chunks ORDER BY note_path, position').all(),
  edges: d.prepare('SELECT src_path, dst, type, resolved, raw FROM edges ORDER BY src_path, dst, type').all(),
})

const STEPS = Number(process.env.FUZZ_STEPS ?? 150)
const SEED = Number(process.env.FUZZ_SEED ?? 20260702)

test(`fuzz: ${STEPS} random mutations (seed ${SEED}), incremental always equals rebuild`, () => {
  const rnd = mulberry32(SEED)
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
  const vault = mkdtempSync(join(tmpdir(), 'omem-fuzz-'))
  for (const dir of ['a', 'b']) mkdirSync(join(vault, dir))

  const names = ['apple', 'banana', 'cherry', 'date', 'elder', 'fig', 'grape']
  const titles = ['Apple Pie', 'Banana Split', 'Cherry Tart', 'Date Night', 'Elder Berry', 'Fig Jam', 'Grape Vine']
  const dirs = ['', 'a/', 'b/']
  const mdFiles = () =>
    dirs.flatMap(d =>
      readdirSync(join(vault, d || '.'))
        .filter(f => f.endsWith('.md'))
        .map(f => d + f),
    )

  const content = () => {
    const links = Array.from({ length: Math.floor(rnd() * 3) }, () => `[[${pick([...names, ...titles])}]]`)
    const title = rnd() < 0.5 ? `---\ntitle: ${pick(titles)}\n---\n` : ''
    const heading = rnd() < 0.5 ? `# ${pick(titles)}\n` : ''
    return `${title}${heading}Body about ${pick(names)} and ${pick(names)}. ${links.join(' ')} #${pick(names)}`
  }

  const db = openDb(':memory:')
  for (let step = 0; step < STEPS; step++) {
    const files = mdFiles()
    const op = rnd()
    if (op < 0.4 || files.length < 3) {
      writeFileSync(join(vault, `${pick(dirs)}${pick(names)}.md`), content()) // create or overwrite
    } else if (op < 0.6) {
      writeFileSync(join(vault, pick(files)), content()) // modify
    } else if (op < 0.8) {
      unlinkSync(join(vault, pick(files))) // delete
    } else {
      const from = pick(files) // rename, possibly across folders
      const to = `${pick(dirs)}${pick(names)}.md`
      if (from !== to) renameSync(join(vault, from), join(vault, to))
    }
    if (step % 5 === 4 || step === STEPS - 1) {
      fullIndex(db, vault)
      const fresh = openDb(':memory:')
      fullIndex(fresh, vault)
      assert.deepEqual(dump(db), dump(fresh), `diverged at step ${step}`)
      fresh.close()
    }
  }
  db.close()
  rmSync(vault, { recursive: true, force: true })
})
