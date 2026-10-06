import type { DatabaseSync } from 'node:sqlite';
import { normalizeGitHubUrl, previewGitHubSource } from './git.ts';
import { transaction } from './db.ts';

const sourceLocks = new WeakMap<DatabaseSync, Set<number>>();

// URL edits and sync share a lock so an asynchronous validation cannot race a fetch.
export function acquireSourceLock(db: DatabaseSync, sourceId: number): (() => void) | undefined {
  let locks = sourceLocks.get(db);
  if (!locks) { locks = new Set(); sourceLocks.set(db, locks); }
  if (locks.has(sourceId)) return undefined;
  locks.add(sourceId);
  return () => { locks.delete(sourceId); };
}

export class SourceFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

interface SourceChange { name?: string; url?: string; syncEnabled?: boolean }
interface SourceRow { id: number; url: string; published_sha: string | null; sync_status: string }

export async function updateSource(db: DatabaseSync, id: number, change: SourceChange, preview = previewGitHubSource) {
  const current = db.prepare('SELECT id, url, published_sha, sync_status FROM sources WHERE id = ? AND enabled = 1').get(id) as SourceRow | undefined;
  if (!current) throw new SourceFailure(404, 'NOT_FOUND', '来源不存在或已移除');
  let url: string | undefined;
  try { url = change.url === undefined ? undefined : normalizeGitHubUrl(change.url); }
  catch (cause) { throw new SourceFailure(400, 'INVALID_URL', cause instanceof Error ? cause.message : '仓库地址无效'); }
  const urlChanged = url !== undefined && url.toLowerCase() !== current.url.toLowerCase();
  let release: (() => void) | undefined;
  let branch: string | undefined;
  try {
    if (urlChanged) {
      if (current.sync_status === 'running' || !(release = acquireSourceLock(db, id))) {
        throw new SourceFailure(409, 'SOURCE_BUSY', '来源正在同步或修改，请完成后再修改仓库链接');
      }
      rejectDuplicate(db, id, url!);
      try { branch = (await preview(url!)).branch; }
      catch (cause) { throw new SourceFailure(400, 'SOURCE_UNAVAILABLE', cause instanceof Error ? cause.message : '仓库不可访问'); }
    }
    transaction(db, () => {
      if (urlChanged) rejectDuplicate(db, id, url!); // Other sources may have changed during validation.
      const result = db.prepare(`UPDATE sources SET name = COALESCE(?, name), url = COALESCE(?, url),
        branch = COALESCE(?, branch), sync_enabled = COALESCE(?, sync_enabled),
        sync_status = CASE WHEN ? THEN 'pending' ELSE sync_status END,
        last_error = CASE WHEN ? THEN NULL ELSE last_error END
        WHERE id = ? AND enabled = 1`)
        .run(change.name ?? null, urlChanged ? url! : null, branch ?? null,
          change.syncEnabled === undefined ? null : Number(change.syncEnabled), Number(urlChanged), Number(urlChanged), id);
      if (!result.changes) throw new SourceFailure(404, 'NOT_FOUND', '来源不存在或已移除');
    });
    return { id, urlChanged };
  } finally { release?.(); }
}

function rejectDuplicate(db: DatabaseSync, id: number, url: string): void {
  const duplicate = db.prepare('SELECT enabled FROM sources WHERE lower(url) = lower(?) AND id <> ?').get(url, id) as { enabled: number } | undefined;
  if (duplicate) throw new SourceFailure(409, 'DUPLICATE_SOURCE', duplicate.enabled ? '这个仓库已经属于另一个知识源' : '这个仓库对应一个已移除的知识源，请从添加来源中恢复');
}
