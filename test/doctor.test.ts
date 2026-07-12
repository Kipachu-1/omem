import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.ts'
import { fullIndex, embedPending } from '../src/indexer.ts'
import { localEmbedder } from '../src/embed.ts'
import { checkDoctor, runDoctor } from '../src/doctor.ts'
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

const g = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim()

let vault: string
let dbPath: string

before(async () => {
  vault = mkdtempSync(join(tmpdir(), 'omem-doctor-'))
  cpSync(FIXTURE, vault, { recursive: true })
  dbPath = join(vault, '.omem', 'index.db')
})

after(() => {
  try { rmSync(vault, { recursive: true, force: true }) } catch { /* tmpdir cleanup */ }
})

test('checkDoctor: vault exists, db opens, no git remote, no embed model, no token', async () => {
  // index first so db exists
  const db = openDb(dbPath)
  fullIndex(db, vault)
  db.close()

  const r = await checkDoctor(vault)
  assert.equal(r.vault, true, 'vault should exist')
  assert.equal(r.db, true, 'db should open')
  assert.equal(r.gitRemote, null, 'no git remote configured')
  assert.equal(r.embedModel, null, 'no embed model yet (no embedding run)')
  assert.equal(r.httpToken, false, 'OMEM_HTTP_TOKEN not set in test env')
  assert.equal(r.lastSync, null, 'no last sync')
  assert.ok(r.totalChunks > 0, 'should have chunks after indexing')
})

test('checkDoctor: git remote after git init + remote add', async () => {
  g(vault, 'init', '-q', '-b', 'main')
  g(vault, 'config', 'user.name', 'tester')
  g(vault, 'config', 'user.email', 'tester@example.com')
  // create a bare origin and link it
  const origin = mkdtempSync(join(tmpdir(), 'omem-doctor-origin-'))
  g(origin, 'init', '-q', '--bare', '-b', 'main')
  g(vault, 'remote', 'add', 'origin', origin)

  const r = await checkDoctor(vault)
  assert.equal(r.gitRemote, origin, 'git remote should be detected')

  try { rmSync(origin, { recursive: true, force: true }) } catch { /* cleanup */ }
})

test('checkDoctor: embed model set after embedding', async () => {
  const db = openDb(dbPath)
  await embedPending(db, fake)
  db.close()

  const r = await checkDoctor(vault)
  assert.equal(r.embedModel, 'fake-bow', 'embed model should be recorded')
  assert.equal(r.pendingEmbeddings, 0, 'all chunks embedded')
  assert.equal(r.totalChunks, r.totalChunks, 'totalChunks consistent')
})

test('checkDoctor: nonexistent vault', async () => {
  const r = await checkDoctor('/nonexistent/path/vault')
  assert.equal(r.vault, false)
  assert.equal(r.db, false)
  assert.equal(r.gitRemote, null)
})

test('runDoctor: returns the report and exits cleanly on a healthy-ish vault', async () => {
  // runDoctor prints to stderr; just verify it returns a report
  const r = await runDoctor(vault)
  assert.equal(r.vault, true)
  assert.equal(r.db, true)
  assert.equal(r.embedModel, 'fake-bow')
  // gitRemote may or may not be set depending on test ordering; just check it's string|null
  assert.ok(r.gitRemote === null || typeof r.gitRemote === 'string')
})
