import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { openDb } from '../src/db.ts'
import { bytesFor, createBundle, readBundle, skillFileSchema, writeBundle } from '../src/skills/bundle.ts'
import type { SkillFile } from '../src/skills/bundle.ts'
import { createSkillStore } from '../src/skills/store.ts'

function instruction(name = 'alpha', description = 'Alpha helper'): SkillFile {
  return skillFileSchema.parse({ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description}\nclient-extension:\n  model: custom\n---\n\n# Instructions\n\nRun the helper.\n` })
}
function fixture(t: TestContext) {
  const vault = mkdtempSync(join(tmpdir(), 'omem-skills-'))
  const db = openDb(join(vault, 'db.sqlite'))
  t.after(() => { db.close(); rmSync(vault, { recursive: true, force: true }) })
  return { vault, db, store: createSkillStore(db, vault) }
}

test('bundles preserve raw frontmatter, binary bytes, executable scripts, and revision', t => {
  const { vault } = fixture(t)
  const files = [instruction(), skillFileSchema.parse({ path: 'assets/blob.bin', content: '/wAB/w==', encoding: 'base64' }), skillFileSchema.parse({ path: 'scripts/run.sh', content: '#!/bin/sh\nexit 0\n', executable: true }), skillFileSchema.parse({ path: 'assets/bom.txt', content: '\uFEFFhello' })]
  const directory = join(vault, 'alpha')
  writeBundle(directory, files)
  const original = createBundle(files, 'alpha')
  const copied = readBundle(directory)
  assert.equal(copied.revision, original.revision)
  assert.equal(copied.files.find(file => file.path === 'SKILL.md')?.content, files[0].content)
  assert.deepEqual(readFileSync(join(directory, 'assets/blob.bin')), Buffer.from([255, 0, 1, 255]))
  if (process.platform !== 'win32') assert.equal(lstatSync(join(directory, 'scripts/run.sh')).mode & 0o111, 0o111)
  assert.equal(copied.instructions, '\n# Instructions\n\nRun the helper.\n')
  assert.throws(() => writeBundle(directory, files), /already exists/)
})

test('bundles require portable names and valid required metadata', () => {
  for (const raw of ['# no metadata', '---\nname: alpha\ndescription: no close', '---\nname: alpha\n---\nBody', '---\nname: Bad_Name\ndescription: hi\n---\nBody', '---\nname: alpha\ndescription: " "\n---\nBody', `---\nname: alpha\ndescription: ${'x'.repeat(1025)}\n---\nBody`]) assert.throws(() => createBundle([{ ...instruction(), content: raw }]))
  assert.throws(() => createBundle([instruction()], 'other'), /does not match/)
  assert.throws(() => createBundle([]), /SKILL.md/)
})

test('paths reject traversal, absolute paths, collisions, and file-directory conflicts', () => {
  for (const path of ['../escape', '/absolute', 'C:/absolute', 'a\\b', './a', 'a//b', 'a/../b', 'a\0b']) assert.throws(() => createBundle([instruction(), { ...instruction(), path }]))
  for (const paths of [['a', 'A'], ['a', 'a/x'], ['A/one', 'a/two'], ['é/one', 'e\u0301/two']]) assert.throws(() => createBundle([instruction(), ...paths.map(path => ({ ...instruction(), path }))]))
  assert.throws(() => bytesFor({ ...instruction(), encoding: 'base64', content: '@@==' }), /base64/)
})

test('bundle revisions include executable flags and ignore file order or byte encoding', () => {
  const extra = skillFileSchema.parse({ path: 'a.txt', content: 'hello' })
  const initial = createBundle([instruction(), extra])
  assert.equal(createBundle([{ ...extra, encoding: 'base64', content: 'aGVsbG8=' }, instruction()]).revision, initial.revision)
  assert.notEqual(createBundle([instruction(), { ...extra, executable: true }]).revision, initial.revision)
  assert.notEqual(createBundle([instruction(), { ...extra, path: 'b.txt' }]).revision, initial.revision)
})

test('readBundle enforces directory name and safely materializes internal links', t => {
  const { vault } = fixture(t)
  const directory = join(vault, 'alpha')
  writeBundle(directory, [instruction(), skillFileSchema.parse({ path: 'target.txt', content: 'safe' })])
  symlinkSync('target.txt', join(directory, 'link.txt'))
  assert.equal(readBundle(directory).files.find(file => file.path === 'link.txt')?.content, 'safe')
  mkdirSync(join(directory, 'folder')); writeFileSync(join(directory, 'folder/a'), 'nested')
  symlinkSync('folder', join(directory, 'linked-folder'))
  assert.equal(readBundle(directory).files.find(file => file.path === 'linked-folder/a')?.content, 'nested')
  symlinkSync('.', join(directory, 'loop'))
  assert.throws(() => readBundle(directory), /cycle/)
  rmSync(join(directory, 'loop'))
  writeFileSync(join(vault, 'outside'), 'secret'); symlinkSync('../outside', join(directory, 'escape'))
  assert.throws(() => readBundle(directory), /escapes/)
  rmSync(join(directory, 'escape'))
  renameSync(directory, join(vault, 'other'))
  assert.throws(() => readBundle(join(vault, 'other')), /does not match/)
})

test('store creates, patches, retains, removes, and rejects stale revisions', t => {
  const { store } = fixture(t)
  const initial = store.write({ name: 'alpha', expectedRevision: null, files: [instruction(), { path: 'keep.txt', content: 'keep' }, { path: 'remove.txt', content: 'remove' }] })
  assert.deepEqual(store.get('alpha'), initial)
  assert.throws(() => store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] }), /conflict/)
  const next = store.write({ name: 'alpha', expectedRevision: initial.revision, files: [{ path: 'new.txt', content: 'new' }], removeFiles: ['remove.txt'] })
  assert.equal(store.readFile({ name: 'alpha', path: 'keep.txt', expectedRevision: next.revision }).content, 'keep')
  assert.throws(() => store.readFile({ name: 'alpha', path: 'remove.txt', expectedRevision: next.revision }), /not found/)
  assert.throws(() => store.readFile({ name: 'alpha', path: 'keep.txt', expectedRevision: initial.revision }), /conflict/)
  assert.throws(() => store.write({ name: 'alpha', expectedRevision: initial.revision, files: [] }), /conflict/)
  assert.throws(() => store.write({ name: 'alpha', expectedRevision: next.revision, files: [], removeFiles: ['SKILL.md'] }), /SKILL.md/)
  assert.deepEqual(store.get('alpha'), next)
})

test('store lists metadata with deterministic keyword ranking, pagination, and invalid diagnostics', t => {
  const { store, vault } = fixture(t)
  for (const name of ['zulu', 'alpha', 'helper']) store.write({ name, expectedRevision: null, files: [instruction(name, name === 'alpha' ? 'Helper description' : 'A helper')] })
  mkdirSync(join(vault, 'skills/broken')); writeFileSync(join(vault, 'skills/broken/SKILL.md'), 'invalid')
  const page = store.list({ query: 'helper', limit: 1, offset: 1 })
  assert.equal(page.total, 3)
  assert.deepEqual(page.skills.map(skill => skill.name), ['alpha'])
  assert.deepEqual(Object.keys(page.skills[0]).sort(), ['description', 'name', 'revision'])
  assert.equal(page.diagnostics.length, 1)
  assert.equal(page.diagnostics[0].name, 'broken')
  assert.deepEqual(store.list({ query: 'not found' }).skills, [])
})

test('archive checks revisions, preserves the bundle, and is idempotent', t => {
  const { store, vault } = fixture(t)
  const skill = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  assert.throws(() => store.archive({ name: 'alpha', expectedRevision: '0'.repeat(64) }), /conflict/)
  const result = store.archive({ name: 'alpha', expectedRevision: skill.revision })
  assert.equal(readBundle(join(vault, result.archived), 'alpha').revision, skill.revision)
  assert.throws(() => store.get('alpha'), /not found/)
  assert.deepEqual(store.archive({ name: 'alpha', expectedRevision: skill.revision }), result)
  const recreated = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  const repeated = store.archive({ name: 'alpha', expectedRevision: recreated.revision })
  assert.notEqual(repeated.archived, result.archived)
  assert.equal(readBundle(join(vault, result.archived), 'alpha').revision, skill.revision)
  assert.equal(readBundle(join(vault, repeated.archived), 'alpha').revision, skill.revision)
})

test('store refuses symlink parents and skill roots without changing outside files', t => {
  const { store, vault } = fixture(t)
  const outside = join(vault, 'outside'); mkdirSync(outside)
  symlinkSync(outside, join(vault, 'skills'))
  assert.throws(() => store.list(), /real directory/)
  rmSync(join(vault, 'skills')); mkdirSync(join(vault, 'skills'))
  writeBundle(join(outside, 'alpha'), [instruction()]); symlinkSync(join(outside, 'alpha'), join(vault, 'skills/alpha'))
  assert.throws(() => store.get('alpha'), /real directory/)
  assert.equal(store.list().diagnostics[0].name, 'alpha')
  assert.equal(readBundle(join(outside, 'alpha')).name, 'alpha')
  rmSync(join(vault, 'skills/alpha')); rmSync(join(vault, 'archive'), { recursive: true }); symlinkSync(outside, join(vault, 'archive'))
  assert.throws(() => store.list(), /real directory/)
})

function interrupted(vault: string, before: string | null, files: SkillFile[], kind: 'write' | 'archive' = 'write') {
  const id = randomUUID()
  const bundle = createBundle(files, 'alpha')
  const directory = join(vault, '.omem/skill-transactions', id)
  mkdirSync(directory, { recursive: true })
  const basename = `alpha-${bundle.revision}`
  const journal = { id, name: 'alpha', beforeRevision: before, afterRevision: bundle.revision, publication: kind === 'write' ? { kind: 'write' } : { kind: 'archive', basename } }
  writeBundle(join(directory, 'stage'), files)
  writeFileSync(join(directory, 'journal.json'), JSON.stringify(journal))
  if (before !== null) renameSync(join(vault, 'skills/alpha'), join(directory, 'backup'))
  const target = kind === 'write' ? join(vault, 'skills/alpha') : join(vault, 'archive/skills', basename)
  renameSync(join(directory, 'stage'), target)
  return { id, directory, target, bundle }
}

test('restart rolls an uncommitted publication back to the exact previous bundle', t => {
  const { store, vault } = fixture(t)
  const original = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  const swap = interrupted(vault, original.revision, [{ ...instruction(), content: instruction().content + '\nChanged.\n' }])
  assert.equal(store.get('alpha').revision, original.revision)
  assert.equal(existsSync(swap.directory), false)
})

test('restart removes an uncommitted create and restores an uncommitted archive', t => {
  const { store, vault } = fixture(t)
  store.list()
  interrupted(vault, null, [instruction()])
  assert.equal(store.list().total, 0)
  const original = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  const swap = interrupted(vault, original.revision, [instruction()], 'archive')
  assert.equal(store.get('alpha').revision, original.revision)
  assert.equal(existsSync(swap.target), false)
})

test('restart finalizes a publication only when its SQLite commit marker and revision agree', t => {
  const { store, vault, db } = fixture(t)
  const original = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  const swap = interrupted(vault, original.revision, [{ ...instruction(), content: instruction().content + '\nCommitted.\n' }])
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`skill.transaction.${swap.id}`, swap.bundle.revision)
  assert.equal(store.get('alpha').revision, swap.bundle.revision)
  assert.equal(existsSync(swap.directory), false)
})

test('restart restores a backup when a crash occurs before staging is published', t => {
  const { store, vault } = fixture(t)
  const original = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  const swap = interrupted(vault, original.revision, [{ ...instruction(), content: instruction().content + '\nNew.\n' }])
  renameSync(swap.target, join(swap.directory, 'stage'))
  assert.equal(store.get('alpha').revision, original.revision)
  assert.equal(existsSync(swap.directory), false)
})

test('restart finalizes a committed archive without resurrecting the active skill', t => {
  const { store, vault, db } = fixture(t)
  const original = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  const swap = interrupted(vault, original.revision, [instruction()], 'archive')
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`skill.transaction.${swap.id}`, swap.bundle.revision)
  assert.equal(store.list().total, 0)
  assert.equal(readBundle(swap.target, 'alpha').revision, original.revision)
  assert.equal(existsSync(swap.directory), false)
})

test('restart preserves external edits and backup evidence instead of destructive recovery', t => {
  const { store, vault } = fixture(t)
  const original = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  const swap = interrupted(vault, original.revision, [instruction()])
  const external = instruction().content + '\nExternal edit.\n'
  writeFileSync(join(swap.target, 'SKILL.md'), external)
  assert.throws(() => store.get('alpha'), /external edits preserved/)
  assert.equal(readFileSync(join(swap.target, 'SKILL.md'), 'utf8'), external)
  assert.equal(existsSync(join(swap.directory, 'backup/SKILL.md')), true)
})

test('recovery of a prepublication journal does not delete an externally created skill', t => {
  const { store, vault } = fixture(t)
  store.list()
  const id = randomUUID(); const directory = join(vault, '.omem/skill-transactions', id)
  mkdirSync(directory)
  const bundle = createBundle([instruction()])
  writeBundle(join(directory, 'stage'), bundle.files)
  writeFileSync(join(directory, 'journal.json'), JSON.stringify({ id, name: 'alpha', beforeRevision: null, afterRevision: bundle.revision, publication: { kind: 'write' } }))
  writeBundle(join(vault, 'skills/alpha'), bundle.files)
  assert.equal(store.get('alpha').revision, bundle.revision)
  assert.equal(existsSync(directory), false)
})

test('two processes updating one revision serialize and only one compare-and-swap succeeds', async t => {
  const { store, vault } = fixture(t)
  const initial = store.write({ name: 'alpha', expectedRevision: null, files: [instruction()] })
  const dbUrl = pathToFileURL(join(process.cwd(), 'src/db.ts')).href
  const storeUrl = pathToFileURL(join(process.cwd(), 'src/skills/store.ts')).href
  async function child(content: string): Promise<number | null> {
    const script = `import {openDb} from ${JSON.stringify(dbUrl)}; import {createSkillStore} from ${JSON.stringify(storeUrl)}; const db = openDb(${JSON.stringify(join(vault, 'db.sqlite'))}); try { createSkillStore(db, ${JSON.stringify(vault)}).write({name:'alpha',expectedRevision:${JSON.stringify(initial.revision)},files:[{path:'winner.txt',content:${JSON.stringify(content)}}]}); } catch(e) { if(!String(e).includes('revision conflict')) { console.error(e); process.exitCode=2; } else process.exitCode=1; } finally {db.close();}`
    return new Promise((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''; process.stderr.on('data', chunk => { stderr += String(chunk) })
      process.on('error', reject); process.on('close', code => code === 2 ? reject(new Error(stderr)) : resolve(code))
    })
  }
  assert.deepEqual((await Promise.all([child('first'), child('second')])).sort(), [0, 1])
  const winner = store.get('alpha')
  assert.ok(['first', 'second'].includes(store.readFile({ name: 'alpha', path: 'winner.txt', expectedRevision: winner.revision }).content))
})
