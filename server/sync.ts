import type { DatabaseSync } from 'node:sqlite';
import { fetchSource, listMarkdown, previewGitHubSource, readTreeFile, summarizeMarkdown, type IndexedDocument } from './git.ts';
import { transaction } from './db.ts';
import { acquireSourceLock, SourceFailure } from './sources.ts';

interface SourceRow {
  id: number;
  url: string;
  branch: string;
  published_sha: string | null;
  sync_enabled: number;
}

interface DocumentRow {
  id: number;
  path: string;
  content_hash: string;
  status: string;
}

export function queueSync(db: DatabaseSync, dataDir: string, sourceId: number, preview = previewGitHubSource): number {
  const source = db.prepare('SELECT id, url, branch, published_sha, sync_enabled FROM sources WHERE id = ? AND enabled = 1').get(sourceId) as SourceRow | undefined;
  if (!source) throw new Error('来源不存在');
  if (!source.sync_enabled) throw new Error('来源已暂停同步');
  const release = acquireSourceLock(db, sourceId);
  if (!release) {
    const existing = db.prepare("SELECT id FROM sync_runs WHERE source_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(sourceId) as { id: number } | undefined;
    if (existing) return existing.id;
    throw new SourceFailure(409, 'SOURCE_BUSY', '来源正在修改，请稍后再同步');
  }
  let runId: number;
  try {
    runId = transaction(db, () => {
      const run = db.prepare("INSERT INTO sync_runs(source_id, from_sha, status, stage) VALUES (?, ?, 'running', 'queued')").run(sourceId, source.published_sha);
      db.prepare("UPDATE sources SET sync_status = 'running', last_error = NULL WHERE id = ?").run(sourceId);
      return Number(run.lastInsertRowid);
    });
  } catch (cause) { release(); throw cause; }
  void (async () => {
    try {
      stage(db, runId, 'checking');
      const upstream = await preview(source.url);
      stage(db, runId, 'fetching');
      const { repo, sha } = await fetchSource(dataDir, sourceId, source.url, upstream.branch);
      stage(db, runId, 'indexing');
      await publishSnapshot(db, sourceId, runId, repo, sha, upstream.branch);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : '同步失败';
      db.prepare("UPDATE sync_runs SET status = 'failed', stage = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(message, runId);
      db.prepare("UPDATE sources SET sync_status = 'failed', last_error = ? WHERE id = ?").run(message, sourceId);
    } finally {
      release();
    }
  })();
  return runId;
}

function stage(db: DatabaseSync, runId: number, value: string): void {
  db.prepare('UPDATE sync_runs SET stage = ? WHERE id = ?').run(value, runId);
}

function relocateAnnotations(db: DatabaseSync, documentId: number, body: string): void {
  const marks = db.prepare("SELECT id, exact, prefix, suffix FROM annotations WHERE document_id = ? AND anchor_status <> 'needs_review'").all(documentId) as Array<{ id: number; exact: string; prefix: string; suffix: string }>;
  for (const mark of marks) {
    if (!mark.exact) continue;
    const matches: number[] = [];
    let start = 0;
    while ((start = body.indexOf(mark.exact, start)) >= 0) {
      matches.push(start);
      start += Math.max(1, mark.exact.length);
      if (matches.length > 100) break;
    }
    const valid = matches.filter((index) => {
      const before = body.slice(Math.max(0, index - mark.prefix.length), index);
      const after = body.slice(index + mark.exact.length, index + mark.exact.length + mark.suffix.length);
      return (!mark.prefix || before === mark.prefix) && (!mark.suffix || after === mark.suffix);
    });
    if (valid.length === 1) {
      db.prepare("UPDATE annotations SET start_offset = ?, end_offset = ?, anchor_status = 'relocated', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(valid[0], valid[0] + mark.exact.length, mark.id);
    } else {
      db.prepare("UPDATE annotations SET anchor_status = 'needs_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(mark.id);
    }
  }
}

export async function publishSnapshot(
  db: DatabaseSync,
  sourceId: number,
  runId: number,
  repo: string,
  sha: string,
  branch?: string,
): Promise<void> {
  const source = db.prepare('SELECT url, published_url, published_sha FROM sources WHERE id = ?').get(sourceId) as { url: string; published_url: string | null; published_sha: string | null } | undefined;
  if (!source) throw new Error('来源不存在');
  const changedRepository = Boolean(source.published_url && source.published_url.toLowerCase() !== source.url.toLowerCase());
  const files = await listMarkdown(repo, sha);
  const next = new Map<string, IndexedDocument>();
  let totalBytes = 0;
  for (const file of files) {
    const data = await readTreeFile(repo, sha, file.path);
    totalBytes += data.length;
    if (totalBytes > 40 * 1024 * 1024) throw new Error('Markdown 总量超过 40 MB，已停止导入');
    const markdown = data.toString('utf8');
    next.set(file.path, { ...file, ...summarizeMarkdown(markdown, file.path) });
  }
  const previous = db.prepare('SELECT id, path, content_hash, status FROM documents WHERE source_id = ?').all(sourceId) as unknown as DocumentRow[];
  const byPath = new Map(previous.map((doc) => [doc.path, doc]));
  const removed = previous.filter((doc) => doc.status === 'current' && !next.has(doc.path));
  const potentialRenames = new Map<string, DocumentRow[]>();
  for (const doc of removed) potentialRenames.set(doc.content_hash, [...(potentialRenames.get(doc.content_hash) ?? []), doc]);

  transaction(db, () => {
    const current = db.prepare('SELECT url, enabled FROM sources WHERE id = ?').get(sourceId) as { url: string; enabled: number } | undefined;
    if (!current?.enabled || current.url !== source.url) throw new Error('来源状态已变化，请重新同步');
    const changed = db.prepare('INSERT INTO document_changes(sync_run_id, document_id, old_path, new_path, kind) VALUES (?, ?, ?, ?, ?)');
    const updateSearch = db.prepare('INSERT INTO document_search(title, body, document_id, source_id) VALUES (?, ?, ?, ?)');
    for (const [path, doc] of next) {
      let existing = byPath.get(path);
      let renameFrom: string | null = null;
      if (!existing) {
        const candidates = potentialRenames.get(doc.hash) ?? [];
        if (candidates.length === 1) {
          existing = candidates[0];
          renameFrom = existing.path;
          potentialRenames.delete(doc.hash);
        }
      }
      if (existing) {
        db.prepare('UPDATE documents SET path = ?, title = ?, status = ?, current_sha = ?, content_hash = ? WHERE id = ?')
          .run(path, doc.title, 'current', sha, doc.hash, existing.id);
        db.prepare('DELETE FROM document_search WHERE document_id = ?').run(existing.id);
        updateSearch.run(doc.title, doc.body, existing.id, sourceId);
        if (renameFrom || existing.status !== 'current' || existing.content_hash !== doc.hash) {
          changed.run(runId, existing.id, renameFrom ?? existing.path, path, renameFrom ? 'renamed' : existing.status !== 'current' ? 'added' : 'modified');
          if (!changedRepository && existing.content_hash !== doc.hash) relocateAnnotations(db, existing.id, doc.body);
        }
        if (renameFrom) byPath.delete(renameFrom);
      } else {
        const result = db.prepare("INSERT INTO documents(source_id, path, title, status, current_sha, content_hash) VALUES (?, ?, ?, 'current', ?, ?)")
          .run(sourceId, path, doc.title, sha, doc.hash);
        const documentId = Number(result.lastInsertRowid);
        updateSearch.run(doc.title, doc.body, documentId, sourceId);
        changed.run(runId, documentId, null, path, 'added');
      }
    }
    for (const doc of removed) {
      if (!byPath.has(doc.path)) continue;
      db.prepare("UPDATE documents SET status = 'deleted' WHERE id = ?").run(doc.id);
      db.prepare('DELETE FROM document_search WHERE document_id = ?').run(doc.id);
      db.prepare("UPDATE annotations SET anchor_status = 'needs_review', updated_at = CURRENT_TIMESTAMP WHERE document_id = ?").run(doc.id);
      changed.run(runId, doc.id, doc.path, null, 'deleted');
    }
    if (changedRepository) {
      db.prepare(`UPDATE annotations SET anchor_status = 'needs_review', updated_at = CURRENT_TIMESTAMP
        WHERE document_id IN (SELECT id FROM documents WHERE source_id = ?)`).run(sourceId);
    }
    db.prepare('UPDATE sources SET published_sha = ?, published_url = ?, branch = COALESCE(?, branch), sync_status = ?, last_error = NULL, last_sync_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(sha, source.url, branch ?? null, 'ready', sourceId);
    db.prepare("UPDATE sync_runs SET to_sha = ?, status = 'success', stage = 'done', finished_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(sha, runId);
  });
}
