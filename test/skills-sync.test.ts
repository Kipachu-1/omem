import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readlinkSync, existsSync, lstatSync, symlinkSync, renameSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createBundle, writeBundle } from '../src/skills/bundle.ts'
import type { SkillBundle } from '../src/skills/bundle.ts'
import type { SkillSource } from '../src/skills/source.ts'
import { getSkillsSyncStatus, syncSkills, recordSkillsSyncFailure } from '../src/skills/sync.ts'

function bundle(name = 'example', body = 'Instructions'): SkillBundle {
  return createBundle([
    { path: 'SKILL.md', content: `---\nname: ${name}\ndescription: A useful skill\n---\n${body}\n`, encoding: 'utf8', executable: false },
    { path: 'assets/image.bin', content: 'AP/+AQ==', encoding: 'base64', executable: false },
    { path: 'scripts/run.sh', content: '#!/bin/sh\nexit 0\n', encoding: 'utf8', executable: true },
  ])
}
function source(initial = [bundle()], id = 'local:test') {
  let bundles = initial
  let fail = false
  let diagnostics: { name: string; error: string }[] = []
  const instance: SkillSource = {
    id,
    async list() { if (fail) throw new Error('offline'); return { skills: bundles.map(({ name, description, revision }) => ({ name, description, revision })), total: bundles.length, diagnostics } },
    async get(name) { const found = bundles.find(bundle => bundle.name === name); if (!found) throw new Error('missing'); return found },
    async write() { throw new Error('unused') }, async close() {},
  }
  return { instance, set(next: SkillBundle[]) { bundles = next }, offline() { fail = true }, invalid() { diagnostics = [{ name: 'example', error: 'invalid SKILL.md' }] } }
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'omem-skill-home-'))
  const stateDir = join(home, 'state')
  const target = join(home, '.agents', 'skills', 'example')
  return { home, stateDir, target, dispose() { rmSync(home, { recursive: true, force: true }) } }
}

test('sync publishes complete binary/executable bundles and native aliases, then updates and removes only managed copies', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir, claude: true, legacyWindsurf: true }
    assert.deepEqual((await syncSkills(options)).installed, ['example'])
    assert.deepEqual(readFileSync(join(f.target, 'assets/image.bin')), Buffer.from([0, 255, 254, 1]))
    assert.ok(lstatSync(join(f.target, 'scripts/run.sh')).mode & 0o111)
    const claude = join(f.home, '.claude', 'skills', 'example')
    const windsurf = join(f.home, '.codeium', 'windsurf', 'skills', 'example')
    assert.equal(readlinkSync(claude), f.target)
    assert.equal(readlinkSync(windsurf), f.target)
    assert.deepEqual((await syncSkills(options)).unchanged, ['example'])
    s.set([bundle('example', 'Updated')])
    assert.deepEqual((await syncSkills(options)).updated, ['example'])
    assert.match(readFileSync(join(claude, 'SKILL.md'), 'utf8'), /Updated/)
    mkdirSync(join(f.home, '.agents', 'skills', 'unmanaged'))
    s.set([])
    assert.deepEqual((await syncSkills(options)).removed, ['example'])
    assert.equal(existsSync(f.target), false); assert.equal(existsSync(claude), false); assert.equal(existsSync(windsurf), false)
    assert.equal(existsSync(join(f.home, '.agents', 'skills', 'unmanaged')), true)
    assert.equal(getSkillsSyncStatus(options).installed.length, 0)
  } finally { f.dispose() }
})

test('unmanaged identical copies require adoption and edited copies require explicit overwrite with recoverable backup', async () => {
  const f = fixture(); const s = source()
  try {
    mkdirSync(join(f.home, ".agents", "skills"), { recursive: true })
    writeBundle(f.target, bundle().files)
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    assert.equal((await syncSkills(options)).conflicts.length, 1)
    assert.deepEqual((await syncSkills({ ...options, adopt: true })).installed, ['example'])
    writeFileSync(join(f.target, 'SKILL.md'), 'local work')
    assert.equal((await syncSkills(options)).conflicts.length, 1)
    const result = await syncSkills({ ...options, overwriteLocal: true })
    assert.deepEqual(result.updated, ['example']); assert.equal(result.backups.length, 1)
    assert.equal(readFileSync(join(result.backups[0], 'SKILL.md'), 'utf8'), 'local work')
  } finally { f.dispose() }
})

test('Claude reserved names install shared copies while preserving the client-owned sync directory', async () => {
  const f = fixture(); const s = source([bundle('synced'), bundle('anthropic-skills')])
  try {
    const clientDirectory = join(f.home, '.claude', 'skills', 'synced')
    mkdirSync(clientDirectory, { recursive: true })
    writeFileSync(join(clientDirectory, 'client-owned.md'), 'Claude-owned downloads')
    const result = await syncSkills({ source: s.instance, home: f.home, stateDir: f.stateDir, claude: true })
    assert.deepEqual(result.installed, ['synced', 'anthropic-skills'])
    assert.equal(result.conflicts.length, 2)
    assert.ok(result.conflicts.every(conflict => conflict.reason.includes('reserves this name')))
    assert.equal(readFileSync(join(clientDirectory, 'client-owned.md'), 'utf8'), 'Claude-owned downloads')
    assert.equal(existsSync(join(f.home, '.claude', 'skills', 'anthropic-skills')), false)
    for (const name of ['synced', 'anthropic-skills']) assert.ok(existsSync(join(f.home, '.agents', 'skills', name, 'SKILL.md')))
    assert.ok(getSkillsSyncStatus(f).installed.every(skill => skill.aliases.length === 0))
  } finally { f.dispose() }
})

test('offline or malformed catalogue preserves last-good skills and records failure', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    await syncSkills(options)
    s.set([]); s.invalid()
    assert.equal((await syncSkills(options)).removed.length, 0)
    s.offline()
    await assert.rejects(syncSkills(options), /offline/)
    assert.equal(existsSync(f.target), true)
    assert.equal(getSkillsSyncStatus(options).last?.error, 'offline')
  } finally { f.dispose() }
})

test('foreign-source ownership, edited aliases and whole-root symlinks are preserved', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir, claude: true }
    await syncSkills(options)
    const foreign = source([bundle('example', 'foreign')], 'remote:another')
    assert.equal((await syncSkills({ ...options, source: foreign.instance, overwriteLocal: true })).conflicts.length, 1)
    const alias = join(f.home, '.claude', 'skills', 'example')
    rmSync(alias); symlinkSync(join(f.home, 'elsewhere'), alias)
    s.set([])
    assert.equal((await syncSkills(options)).removed.length, 0)
    assert.equal(readlinkSync(alias), join(f.home, 'elsewhere'))
    assert.equal(existsSync(f.target), true)
    rmSync(join(f.home, '.agents', 'skills'), { recursive: true })
    symlinkSync(join(f.home, '.claude', 'skills'), join(f.home, '.agents', 'skills'))
    s.set([bundle()])
    await assert.rejects(syncSkills(options), /root is not a plain directory/)
  } finally { f.dispose() }
})

test('download mismatch and incomplete retrieval cause no publishing or removals', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    await syncSkills(options)
    s.set([bundle('other')])
    s.instance.get = async () => bundle('other', 'changed mid-download')
    await assert.rejects(syncSkills(options), /changed during sync/)
    assert.equal(existsSync(f.target), true)
    assert.equal(existsSync(join(f.home, '.agents', 'skills', 'other')), false)
  } finally { f.dispose() }
})

test('durable journal restores an interrupted replacement before subsequent sync', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    await syncSkills(options)
    const before = readFileSync(join(f.target, 'SKILL.md'), 'utf8')
    const replacement = bundle('example', 'interrupted')
    const backup = join(f.home, '.agents', 'skills', '.omem-backup-example-test')
    const stage = join(f.home, '.agents', 'skills', '.omem-stage-test')
    writeBundle(stage, replacement.files)
    renameSync(f.target, backup); renameSync(stage, f.target)
    const db = new Database(join(f.stateDir, 'skills-sync.db'))
    db.prepare('INSERT INTO sync_meta(key,value) VALUES (?,?)').run('journal', JSON.stringify({ home: f.home, operations: [{ target: f.target, stage, backup, existed: true, fingerprint: `bundle:${replacement.revision}` }] }))
    db.close()
    assert.deepEqual((await syncSkills(options)).unchanged, ['example'])
    assert.equal(readFileSync(join(f.target, 'SKILL.md'), 'utf8'), before)
    assert.equal(existsSync(backup), false)
  } finally { f.dispose() }
})

test('status inspection does not create native roots or state files', () => {
  const f = fixture()
  try { assert.deepEqual(getSkillsSyncStatus(f), { installed: [], last: null }); assert.equal(existsSync(f.stateDir), false) }
  finally { f.dispose() }
})

test('separate sync processes serialize native publishing and preserve the winning source ownership', async () => {
  const f = fixture()
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const syncUrl = new URL('../src/skills/sync.ts', import.meta.url).href
  const bundleUrl = new URL('../src/skills/bundle.ts', import.meta.url).href
  const data = bundle().files
  function worker(id: string) {
    const code = `import {syncSkills} from ${JSON.stringify(syncUrl)}; import {createBundle} from ${JSON.stringify(bundleUrl)};
      const bundle=createBundle(${JSON.stringify(data)}); const source={id:${JSON.stringify(id)},async list(){return {skills:[bundle],total:1,diagnostics:[]}},async get(){return bundle},async write(){throw Error('unused')},async close(){}};
      console.log(JSON.stringify(await syncSkills({source,home:${JSON.stringify(f.home)},stateDir:${JSON.stringify(f.stateDir)},claude:true})));`
    return run(process.execPath, ['--input-type=module', '-e', code])
  }
  try {
    const results = await Promise.all([worker('process:a'), worker('process:b')])
    const reports = results.map(result => JSON.parse(result.stdout))
    assert.equal(reports.flatMap(report => report.installed).length, 1)
    assert.equal(reports.flatMap(report => report.conflicts).length, 1)
    assert.equal(getSkillsSyncStatus(f).installed.length, 1)
    assert.equal(readlinkSync(join(f.home, '.claude', 'skills', 'example')), f.target)
  } finally { f.dispose() }
})

test('recovery retains edits made to an interrupted replacement instead of removing them', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    await syncSkills(options)
    const replacement = bundle('example', 'interrupted')
    const backup = join(f.home, '.agents', 'skills', '.omem-backup-example-edit')
    const stage = join(f.home, '.agents', 'skills', '.omem-stage-edit')
    writeBundle(stage, replacement.files)
    renameSync(f.target, backup); renameSync(stage, f.target)
    writeFileSync(join(f.target, 'SKILL.md'), 'edited after interrupted sync')
    const db = new Database(join(f.stateDir, 'skills-sync.db'))
    db.prepare('INSERT INTO sync_meta(key,value) VALUES (?,?)').run('journal', JSON.stringify({ home: f.home, operations: [{ target: f.target, stage, backup, existed: true, fingerprint: `bundle:${replacement.revision}` }] }))
    db.close()
    await assert.rejects(syncSkills(options), /Interrupted sync target was edited/)
    assert.equal(readFileSync(join(f.target, 'SKILL.md'), 'utf8'), 'edited after interrupted sync')
    assert.equal(existsSync(backup), true)
  } finally { f.dispose() }
})

test('sync rejects state directory, database and SQLite sidecar symlinks without touching their destinations', async () => {
  const f = fixture(); const s = source()
  try {
    const external = join(f.home, 'outside')
    mkdirSync(external)
    symlinkSync(external, f.stateDir)
    await assert.rejects(syncSkills({ source: s.instance, home: f.home, stateDir: f.stateDir }), /symlink/)
    assert.deepEqual(getSkillsSyncStatus({ home: f.home, stateDir: external }), { installed: [], last: null })
    rmSync(f.stateDir); mkdirSync(f.stateDir)
    const sentinel = join(external, 'sentinel')
    writeFileSync(sentinel, 'preserve')
    for (const name of ['skills-sync.db', 'skills-sync-lock.db', 'skills-sync.db-wal', 'skills-sync.db-shm']) {
      const path = join(f.stateDir, name)
      symlinkSync(sentinel, path)
      await assert.rejects(syncSkills({ source: s.instance, home: f.home, stateDir: f.stateDir }), /symlink/)
      assert.equal(readFileSync(sentinel, 'utf8'), 'preserve')
      rmSync(path)
    }
    const other = new Database(join(f.stateDir, 'skills-sync.db'))
    other.exec("CREATE TABLE precious (value TEXT); INSERT INTO precious VALUES ('keep')")
    other.close()
    await assert.rejects(syncSkills({ source: s.instance, home: f.home, stateDir: f.stateDir }), /unrelated SQLite/)
    const check = new Database(join(f.stateDir, 'skills-sync.db'), { readonly: true })
    assert.deepEqual(check.prepare('SELECT value FROM precious').get(), { value: 'keep' }); check.close()
  } finally { f.dispose() }
})

test('process death during a native swap releases the writer lock and recovers the prior complete skill', async () => {
  const f = fixture(); const s = source()
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir, claude: true }
    await syncSkills(options)
    const oldBytes = readFileSync(join(f.target, 'SKILL.md'), 'utf8')
    const next = bundle('example', 'replacement interrupted by SIGKILL')
    const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      import {syncSkills} from ${JSON.stringify(new URL('../src/skills/sync.ts', import.meta.url).href)};
      const bundle=${JSON.stringify(next)}; const source={id:'local:test',async list(){return {skills:[bundle],total:1,diagnostics:[]}},async get(){return bundle}};
      const rename=fs.renameSync; fs.renameSync=(from,to)=>{rename(from,to);if(from===${JSON.stringify(f.target)}) process.kill(process.pid,'SIGKILL')};syncBuiltinESMExports();
      await syncSkills({source,home:${JSON.stringify(f.home)},stateDir:${JSON.stringify(f.stateDir)},claude:true});`
    await assert.rejects(run(process.execPath, ['--input-type=module', '-e', code]), error => error instanceof Error && 'signal' in error && error.signal === 'SIGKILL')
    assert.equal(existsSync(f.target), false)
    assert.deepEqual((await syncSkills(options)).unchanged, ['example'])
    assert.equal(readFileSync(join(f.target, 'SKILL.md'), 'utf8'), oldBytes)
    assert.equal(readFileSync(join(f.home, '.claude', 'skills', 'example', 'SKILL.md'), 'utf8'), oldBytes)
  } finally { f.dispose() }
})

test('a delayed download cannot replace a newer bundle published by a concurrent same-source sync', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    await syncSkills(options)
    const fresh = source([bundle('example', 'newer published bundle')])
    let release = () => {}
    let fetching = () => {}
    const fetched = new Promise<void>(resolve => { fetching = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalGet = s.instance.get
    s.instance.get = async name => { fetching(); await gate; return originalGet(name) }
    const stale = syncSkills(options)
    await fetched
    assert.deepEqual((await syncSkills({ ...options, source: fresh.instance })).updated, ['example'])
    release()
    const result = await stale
    assert.equal(result.conflicts.length, 1)
    assert.match(result.conflicts[0].reason, /changed during download/)
    assert.match(readFileSync(join(f.target, 'SKILL.md'), 'utf8'), /newer published bundle/)
  } finally { f.dispose() }
})

function pendingJournal(f: ReturnType<typeof fixture>, entry: { stage: string; backup: string; existed: boolean; fingerprint: string }) {
  const db = new Database(join(f.stateDir, 'skills-sync.db'))
  db.prepare('INSERT INTO sync_meta(key,value) VALUES (?,?)').run('journal', JSON.stringify({ home: f.home, operations: [{ target: f.target, ...entry }] }))
  db.close()
}

test('an unpublished create journal preserves an externally created identical target', async () => {
  const f = fixture(); const s = source([])
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    await syncSkills(options)
    const planned = bundle()
    const stage = join(f.home, '.agents', 'skills', '.omem-stage-unpublished')
    const backup = join(f.home, '.agents', 'skills', '.omem-backup-example-unpublished')
    writeBundle(stage, planned.files)
    writeBundle(f.target, planned.files)
    const externalInode = lstatSync(f.target).ino
    pendingJournal(f, { stage, backup, existed: false, fingerprint: `bundle:${planned.revision}` })
    s.offline()
    await assert.rejects(syncSkills(options), /offline/)
    assert.equal(lstatSync(f.target).ino, externalInode)
    assert.deepEqual(readFileSync(join(f.target, 'assets', 'image.bin')), Buffer.from([0, 255, 254, 1]))
    assert.equal(existsSync(stage), false)
    assert.equal(getSkillsSyncStatus(options).installed.length, 0)
  } finally { f.dispose() }
})

test('an unpublished replacement with backup preserves an external identical target and all recovery evidence', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    await syncSkills(options)
    const previousBytes = readFileSync(join(f.target, 'SKILL.md'), 'utf8')
    const planned = bundle('example', 'planned replacement')
    const stage = join(f.home, '.agents', 'skills', '.omem-stage-external')
    const backup = join(f.home, '.agents', 'skills', '.omem-backup-example-external')
    writeBundle(stage, planned.files)
    renameSync(f.target, backup)
    writeBundle(f.target, planned.files)
    const externalInode = lstatSync(f.target).ino
    pendingJournal(f, { stage, backup, existed: true, fingerprint: `bundle:${planned.revision}` })
    let fetched = false
    s.instance.list = async () => { fetched = true; throw new Error('offline') }
    await assert.rejects(syncSkills(options), /externally created/)
    assert.equal(fetched, false)
    assert.equal(lstatSync(f.target).ino, externalInode)
    assert.equal(readFileSync(join(backup, 'SKILL.md'), 'utf8'), previousBytes)
    assert.equal(existsSync(stage), true)
    const db = new Database(join(f.stateDir, 'skills-sync.db'), { readonly: true })
    assert.ok(db.prepare("SELECT value FROM sync_meta WHERE key='journal'").get())
    db.close()
  } finally { f.dispose() }
})

test('offline sync restores the last-good bundle and aliases before trying the source', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir, claude: true }
    await syncSkills(options)
    const previousBytes = readFileSync(join(f.target, 'SKILL.md'), 'utf8')
    const planned = bundle('example', 'planned replacement')
    const stage = join(f.home, '.agents', 'skills', '.omem-stage-offline')
    const backup = join(f.home, '.agents', 'skills', '.omem-backup-example-offline')
    writeBundle(stage, planned.files)
    renameSync(f.target, backup)
    pendingJournal(f, { stage, backup, existed: true, fingerprint: `bundle:${planned.revision}` })
    s.instance.list = async () => {
      assert.equal(readFileSync(join(f.target, 'SKILL.md'), 'utf8'), previousBytes)
      assert.equal(readFileSync(join(f.home, '.claude', 'skills', 'example', 'SKILL.md'), 'utf8'), previousBytes)
      throw new Error('offline')
    }
    await assert.rejects(syncSkills(options), /offline/)
    assert.equal(readFileSync(join(f.target, 'SKILL.md'), 'utf8'), previousBytes)
    assert.equal(existsSync(stage), false); assert.equal(existsSync(backup), false)
    assert.equal(getSkillsSyncStatus(options).last?.error, 'offline')
  } finally { f.dispose() }
})

test('recording a remote connection failure restores an interrupted local bundle without a source connection', async () => {
  const f = fixture(); const s = source()
  try {
    const options = { source: s.instance, home: f.home, stateDir: f.stateDir }
    await syncSkills(options)
    const previousBytes = readFileSync(join(f.target, 'SKILL.md'), 'utf8')
    const planned = bundle('example', 'planned replacement')
    const stage = join(f.home, '.agents', 'skills', '.omem-stage-disconnected')
    const backup = join(f.home, '.agents', 'skills', '.omem-backup-example-disconnected')
    writeBundle(stage, planned.files); renameSync(f.target, backup)
    pendingJournal(f, { stage, backup, existed: true, fingerprint: `bundle:${planned.revision}` })
    recordSkillsSyncFailure({ home: f.home, stateDir: f.stateDir, source: 'remote:offline', error: 'could not connect' })
    assert.equal(readFileSync(join(f.target, 'SKILL.md'), 'utf8'), previousBytes)
    assert.equal(getSkillsSyncStatus(options).last?.error, 'could not connect')
  } finally { f.dispose() }
})


test('status reads fresh committed state without write access or SQLite sidecars', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(); const s = source()
  try {
    await syncSkills({ ...f, source: s.instance })
    const before = readdirSync(f.stateDir).sort()
    chmodSync(f.stateDir, 0o555)
    chmodSync(join(f.stateDir, 'skills-sync.db'), 0o444)
    assert.equal(getSkillsSyncStatus(f).installed[0].revision, bundle().revision)
    assert.deepEqual(readdirSync(f.stateDir).sort(), before)
    chmodSync(f.stateDir, 0o755)
    chmodSync(join(f.stateDir, 'skills-sync.db'), 0o644)
    s.set([bundle('example', 'Latest')])
    await syncSkills({ ...f, source: s.instance })
    chmodSync(f.stateDir, 0o555)
    chmodSync(join(f.stateDir, 'skills-sync.db'), 0o444)
    const status = getSkillsSyncStatus(f)
    assert.equal(status.installed[0].revision, bundle('example', 'Latest').revision)
    assert.deepEqual((status.last?.result as { updated: string[] }).updated, ['example'])
    assert.deepEqual(readdirSync(f.stateDir).sort(), before)
  } finally {
    chmodSync(f.stateDir, 0o755)
    f.dispose()
  }
})

test('writer migrates existing WAL state and preserves committed WAL updates', async () => {
  const f = fixture(); const s = source()
  try {
    await syncSkills({ ...f, source: s.instance })
    const database = join(f.stateDir, 'skills-sync.db')
    // Abrupt exit leaves committed changes in WAL, as an interrupted watcher would.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      const db = new Database(process.argv[1]);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.prepare("INSERT INTO sync_meta(key,value) VALUES ('migration-proof','42')").run();
      process.exit(0);
    `, database], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.ok(existsSync(database + '-wal'))
    await syncSkills({ ...f, source: s.instance })
    const db = new Database(database, { readonly: true })
    try {
      assert.equal(db.pragma('journal_mode', { simple: true }), 'delete')
      assert.deepEqual(db.prepare("SELECT value FROM sync_meta WHERE key='migration-proof'").get(), { value: '42' })
    } finally { db.close() }
    assert.equal(existsSync(database + '-wal'), false)
    assert.equal(existsSync(database + '-shm'), false)
    assert.equal(getSkillsSyncStatus(f).installed.length, 1)
  } finally { f.dispose() }
})


test('WAL migration preserves state when an existing reader blocks conversion', async () => {
  const f = fixture(); const s = source()
  let reader: Database.Database | undefined
  try {
    await syncSkills({ ...f, source: s.instance })
    const database = join(f.stateDir, 'skills-sync.db')
    reader = new Database(database)
    reader.pragma('journal_mode = WAL')
    reader.exec('BEGIN')
    const snapshot = reader.prepare('SELECT value FROM installed').get()
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { recordSkillsSyncFailure } from './src/skills/sync.ts';
      recordSkillsSyncFailure({ home: process.argv[1], stateDir: process.argv[2], source: 'local:test', error: 'migration completed' });
    `, f.home, f.stateDir], { encoding: 'utf8' })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /SQLITE_BUSY/)
    assert.deepEqual(reader.prepare('SELECT value FROM installed').get(), snapshot)
    assert.equal(reader.pragma('journal_mode', { simple: true }), 'wal')
    reader.close(); reader = undefined
    recordSkillsSyncFailure({ ...f, source: 'local:test', error: 'migration completed' })
    assert.equal(getSkillsSyncStatus(f).last?.error, 'migration completed')
    assert.equal(existsSync(database + '-wal'), false)
  } finally { reader?.close(); f.dispose() }
})
