import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/db.ts'
import { fullIndex, embedPending } from '../../src/indexer.ts'
import { search } from '../../src/search.ts'
import { isNavigationOnly } from '../../src/quality.ts'
import { bow } from './bow.ts'

export async function retrievalBenchmark(searchFn: typeof search = search) {
  const cases = JSON.parse(readFileSync(new URL('../fixtures/retrieval.json', import.meta.url), 'utf8')) as { id: string; query: string; answer: string }[]
  const vault = mkdtempSync(join(tmpdir(), 'omem-benchmark-'))
  const db = openDb(':memory:')
  try {
    for (const folder of ['guidance', 'archive', 'navigation']) mkdirSync(join(vault, folder))
    for (const c of cases) {
      writeFileSync(join(vault, `guidance/${c.id}.md`), `---\ntitle: ${c.id}\nkind: decision\n---\n${c.answer}\n`)
      writeFileSync(join(vault, `archive/${c.id}.md`), `---\ntitle: Old ${c.id}\nkind: decision\npinned: true\narchived_at: 2026-01-01\n---\n${c.query}\nObsolete advice: ${c.answer}\n`)
      // Enough navigation matches to expose starvation before the per-leg cutoff.
      for (let i = 0; i < 24; i++) writeFileSync(join(vault, `navigation/${c.id}-${i}.md`), `## Related\n- [[guidance/${c.id}|${c.query}]]\n`)
    }
    fullIndex(db, vault)
    await embedPending(db, bow)
    const modes = []
    for (const [mode, embedder] of [['keyword', null], ['hybrid', bow]] as const) {
      let top1 = 0, top5 = 0, archived = 0, navigation = 0, returned = 0
      for (const c of cases) {
        const results = await searchFn(db, c.query, { limit: 5, embedder })
        const path = `guidance/${c.id}.md`
        top1 += Number(results[0]?.notePath === path)
        top5 += Number(results.some(r => r.notePath === path))
        archived += results.filter(r => r.notePath.startsWith('archive/')).length
        navigation += results.filter(r => isNavigationOnly(r.text)).length
        returned += results.length
      }
      modes.push({ mode, queries: cases.length, top1, top5, archivedResults: archived, navigationResults: navigation, returned })
    }
    return { corpus: '8 curated questions, 8 answer notes, 8 archived notes, 192 navigation notes; deterministic BOW embeddings', modes }
  } finally {
    db.close()
    rmSync(vault, { recursive: true, force: true })
  }
}
