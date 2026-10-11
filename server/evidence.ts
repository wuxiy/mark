import type { DatabaseSync } from 'node:sqlite';
import { mirrorPath, readTreeFile, safeTreePath, summarizeMarkdown } from './git.ts';
import { ModelFailure } from './model-client.ts';

export interface VersionDocument {
  documentId: number; sourceId: number; sourceName: string; title: string;
  path: string; publishedSha: string; markdown: string; plainText: string;
  isCurrent: boolean; sourceEnabled: boolean;
}

export async function readVersion(db: DatabaseSync, dataDir: string, documentId: number, sha: string, requestedPath?: string): Promise<VersionDocument> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha) || (requestedPath && !safeTreePath(requestedPath))) {
    throw new ModelFailure('INVALID_VERSION', '版本或文档路径无效', 400);
  }
  const doc = db.prepare(`SELECT d.path, d.status, d.current_sha AS currentSha, d.source_id AS sourceId,
    s.name AS sourceName, s.published_sha AS publishedSha, s.enabled
    FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = ?`).get(documentId) as
    { path: string; status: string; currentSha: string; sourceId: number; sourceName: string; publishedSha: string; enabled: number } | undefined;
  if (!doc) throw new ModelFailure('NOT_FOUND', '文档不存在', 404);
  const run = db.prepare("SELECT id FROM sync_runs WHERE source_id = ? AND to_sha = ? AND status = 'success' ORDER BY id DESC LIMIT 1").get(doc.sourceId, sha) as { id: number } | undefined;
  let path: string | null | undefined;
  if (run) {
    const last = db.prepare(`SELECT c.new_path AS path FROM document_changes c JOIN sync_runs r ON r.id = c.sync_run_id
      WHERE c.document_id = ? AND r.source_id = ? AND r.status = 'success' AND r.id <= ?
      ORDER BY r.id DESC, c.id DESC LIMIT 1`).get(documentId, doc.sourceId, run.id) as { path: string | null } | undefined;
    path = last?.path;
  }
  if (path === undefined && doc.currentSha === sha && doc.status === 'current') path = doc.path;
  if (path === undefined) {
    const prior = db.prepare(`SELECT c.old_path AS path FROM document_changes c JOIN sync_runs r ON r.id = c.sync_run_id
      WHERE c.document_id = ? AND r.source_id = ? AND r.from_sha = ? AND r.status = 'success'
      ORDER BY r.id LIMIT 1`).get(documentId, doc.sourceId, sha) as { path: string | null } | undefined;
    path = prior?.path;
  }
  if (!path || (requestedPath && requestedPath !== path)) throw new ModelFailure('VERSION_NOT_FOUND', '该版本中没有这篇文档或路径不匹配', 404);
  try {
    const markdown = (await readTreeFile(mirrorPath(dataDir, doc.sourceId), sha, path)).toString('utf8');
    const summary = summarizeMarkdown(markdown, path);
    return { documentId, sourceId: doc.sourceId, sourceName: doc.sourceName, title: summary.title, path, publishedSha: sha,
      markdown, plainText: summary.body, isCurrent: doc.status === 'current' && doc.publishedSha === sha && doc.path === path, sourceEnabled: Boolean(doc.enabled) };
  } catch {
    throw new ModelFailure('VERSION_UNAVAILABLE', '暂时无法读取该版本，引用不会跳到当前正文，请重试', 503);
  }
}

export interface DocumentChange {
  kind: string; oldPath: string | null; newPath: string | null; fromSha: string | null; toSha: string;
  sourceId: number; sourceName: string; title: string; before: string; after: string; documentId: number; runId: number;
}

export async function readChange(db: DatabaseSync, dataDir: string, runId: number, documentId: number): Promise<DocumentChange> {
  const change = db.prepare(`SELECT c.kind, c.old_path AS oldPath, c.new_path AS newPath,
    r.from_sha AS fromSha, r.to_sha AS toSha, r.source_id AS sourceId, d.title, s.name AS sourceName
    FROM document_changes c JOIN sync_runs r ON r.id = c.sync_run_id
    JOIN documents d ON d.id = c.document_id JOIN sources s ON s.id = r.source_id
    WHERE c.sync_run_id = ? AND c.document_id = ? AND r.status = 'success'`).get(runId, documentId) as Omit<DocumentChange, 'before' | 'after' | 'documentId' | 'runId'> | undefined;
  if (!change) throw new ModelFailure('NOT_FOUND', '更新记录不存在', 404);
  try {
    const repo = mirrorPath(dataDir, change.sourceId);
    const [before, after] = await Promise.all([
      change.fromSha && change.oldPath ? readTreeFile(repo, change.fromSha, change.oldPath).then(bytes => bytes.toString('utf8')) : '',
      change.newPath ? readTreeFile(repo, change.toSha, change.newPath).then(bytes => bytes.toString('utf8')) : '',
    ]);
    return { ...change, title: summarizeMarkdown(after || before, change.newPath ?? change.oldPath ?? '').title, before, after, documentId, runId };
  } catch { throw new ModelFailure('VERSION_UNAVAILABLE', '暂时无法读取历史版本，请重试', 503); }
}
