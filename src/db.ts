import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database.Database

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000') // a watcher and an MCP server may share the db across processes
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS notes (
      path        TEXT PRIMARY KEY,   -- vault-relative, posix separators
      title       TEXT NOT NULL,      -- frontmatter title, else filename sans .md
      frontmatter TEXT,               -- raw JSON
      mtime       INTEGER NOT NULL,   -- ms
      hash        TEXT NOT NULL,      -- sha256 of file content
      kind        TEXT,                -- memory class: decision|gotcha|convention|fact|meeting|log (nullable)
      pinned      INTEGER NOT NULL DEFAULT 0  -- 1 if frontmatter pinned is truthy
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY,
      note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
      heading   TEXT,                 -- nearest h1-h3 text, NULL for preamble
      anchor    TEXT,                 -- obsidian heading anchor for deep links
      position  INTEGER NOT NULL,     -- order within note
      text      TEXT NOT NULL,
      embedding BLOB                  -- normalized float32; NULL = pending
    );
    CREATE INDEX IF NOT EXISTS chunks_note ON chunks(note_path);
    CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(note_path) WHERE embedding IS NULL;

    -- ponytail: plain FTS5 with its own text copy (rowid = chunks.id), not
    -- content= external table — a desynced shadow index is worse than the disk
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text);

    CREATE TABLE IF NOT EXISTS edges (
      src_path TEXT NOT NULL,
      dst      TEXT NOT NULL,         -- resolved note path; raw target if unresolved; tag string for type='tag'
      type     TEXT NOT NULL,         -- 'wikilink' | 'tag'
      resolved INTEGER NOT NULL,
      raw      TEXT NOT NULL,         -- original link target; dst reverts to this when the target note is deleted
      -- raw is the edge identity: two different link texts may resolve to the same dst
      PRIMARY KEY (src_path, raw, type)
    );
    CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
    -- partial indexes for reResolve / deleteNote: only wikilink edges are scanned there.
    -- expression index on lower(raw): reResolve matches after lowercasing, so a plain
    -- raw = ? would miss case variants; lower(raw) IN (...) is both correct and indexable.
    CREATE INDEX IF NOT EXISTS edges_wikilink_lraw ON edges(lower(raw)) WHERE type = 'wikilink';
    CREATE INDEX IF NOT EXISTS edges_wikilink_dst ON edges(dst) WHERE type = 'wikilink';
  `)

  // upgrade path for existing dbs created before kind/pinned existed.
  // CREATE TABLE IF NOT EXISTS won't add columns to an existing table, so ALTER.
  // Each wrapped in its own try/catch so re-running openDb is idempotent.
  for (const col of ['kind TEXT', 'pinned INTEGER NOT NULL DEFAULT 0'] as const) {
    const name = col.split(' ')[0]
    try {
      db.exec(`ALTER TABLE notes ADD COLUMN ${col}`)
    } catch (e) {
      // SQLite error "duplicate column name" -> already migrated; anything else rethrows
      const msg = (e as Error).message
      if (!/duplicate column name/i.test(msg)) throw e
      void name
    }
  }
  return db
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
