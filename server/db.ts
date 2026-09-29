import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5_000 });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      published_sha TEXT,
      sync_status TEXT NOT NULL DEFAULT 'queued',
      last_error TEXT,
      last_sync_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id),
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'current',
      current_sha TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(source_id, path)
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id),
      from_sha TEXT,
      to_sha TEXT,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS document_changes (
      id INTEGER PRIMARY KEY,
      sync_run_id INTEGER NOT NULL REFERENCES sync_runs(id),
      document_id INTEGER NOT NULL REFERENCES documents(id),
      old_path TEXT,
      new_path TEXT,
      kind TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id),
      kind TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'green',
      exact TEXT NOT NULL,
      prefix TEXT NOT NULL DEFAULT '',
      suffix TEXT NOT NULL DEFAULT '',
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      created_sha TEXT NOT NULL,
      anchor_status TEXT NOT NULL DEFAULT 'anchored',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reading_states (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id),
      state TEXT NOT NULL DEFAULT 'unread',
      position REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
      title, body, document_id UNINDEXED, source_id UNINDEXED,
      tokenize = 'trigram'
    );
    CREATE INDEX IF NOT EXISTS documents_source_status ON documents(source_id, status);
    CREATE INDEX IF NOT EXISTS sync_runs_source ON sync_runs(source_id, id DESC);
    CREATE INDEX IF NOT EXISTS annotations_document ON annotations(document_id);
  `);
  const sourceColumns = db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>;
  if (!sourceColumns.some((column) => column.name === 'sync_enabled')) db.exec('ALTER TABLE sources ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1');
  // A stopped process cannot leave a task pretending to run. The published SHA stays unchanged.
  db.exec(`
    UPDATE sync_runs SET status = 'failed', stage = 'interrupted',
      error = '进程重启，同步未完成', finished_at = CURRENT_TIMESTAMP
    WHERE status = 'running';
    UPDATE sources SET sync_status = 'failed', last_error = '进程重启，同步未完成'
    WHERE sync_status = 'running';
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
