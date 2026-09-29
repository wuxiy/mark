import { existsSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { answerQuestion, askConfigured, AskFailure, type ModelConfig } from './ask.ts';
import { configured, cookieToken, createSession, deleteSession, getSession, initializePassword, verifyPassword } from './auth.ts';
import { openDatabase } from './db.ts';
import { mirrorPath, previewGitHubSource, readAsset, readTreeFile, safeTreePath, summarizeMarkdown } from './git.ts';
import { queueSync } from './sync.ts';
import { saveSyncIntervalMinutes, syncIntervalMinutes } from './settings.ts';

export interface AppOptions {
  dataDir: string;
  webDir?: string;
  initialPasswordFile?: string;
  secureCookie?: boolean;
  model?: ModelConfig;
}

type Session = { csrf: string; tokenHash: string };

function error(reply: FastifyReply, status: number, code: string, message: string, retryable = false) {
  return reply.code(status).send({ code, message, retryable });
}

function routeId(request: FastifyRequest): number {
  const id = Number((request.params as { id?: string }).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('无效的标识');
  return id;
}

function sessionFor(db: DatabaseSync, request: FastifyRequest): Session | null {
  return getSession(db, cookieToken(request.headers.cookie));
}

function sourceView(db: DatabaseSync) {
  return db.prepare(`
    SELECT s.id, s.name, s.url, s.branch, s.published_sha AS publishedSha,
      s.sync_status AS syncStatus, s.last_error AS lastError, s.last_sync_at AS lastSyncAt,
      s.enabled, s.sync_enabled AS syncEnabled,
      (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.status = 'current') AS documentCount
    FROM sources s WHERE s.enabled = 1 ORDER BY s.created_at DESC, s.id DESC
  `).all();
}

export async function buildApp(options: AppOptions) {
  const db = openDatabase(join(options.dataDir, 'mark.db'));
  initializePassword(db, options.initialPasswordFile);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const loginFailures = new Map<string, { count: number; until: number }>();
  app.addHook('onClose', async () => db.close());
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === '/api/health' || path === '/api/session' || path === '/api/login' || !path.startsWith('/api/')) return;
    if (!configured(db)) return error(reply, 503, 'NOT_CONFIGURED', '请先通过本地部署流程设置密码');
    const session = sessionFor(db, request);
    if (!session) return error(reply, 401, 'UNAUTHORIZED', '请登录后继续');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.headers['x-csrf-token'] !== session.csrf) {
      return error(reply, 403, 'CSRF', '会话校验失败，请刷新后重试');
    }
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/session', async (request) => {
    const session = sessionFor(db, request);
    return { configured: configured(db), authenticated: Boolean(session), csrf: session?.csrf ?? null };
  });
  app.post('/api/login', async (request, reply) => {
    if (!configured(db)) return error(reply, 503, 'NOT_CONFIGURED', '请先通过本地部署流程设置密码');
    const parsed = z.object({ password: z.string().min(1).max(512) }).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '请输入密码');
    const key = request.ip;
    const failure = loginFailures.get(key);
    if (failure && failure.count >= 5 && Date.now() < failure.until) return error(reply, 429, 'RATE_LIMITED', '尝试次数过多，请稍后再试');
    if (!verifyPassword(db, parsed.data.password)) {
      loginFailures.set(key, { count: (failure?.count ?? 0) + 1, until: Date.now() + 15 * 60_000 });
      return error(reply, 401, 'INVALID_PASSWORD', '密码不正确');
    }
    loginFailures.delete(key);
    const session = createSession(db);
    reply.header('Set-Cookie', `mark_session=${session.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000${options.secureCookie ? '; Secure' : ''}`);
    return { authenticated: true, csrf: session.csrf };
  });
  app.post('/api/logout', async (request, reply) => {
    const session = sessionFor(db, request);
    if (session) deleteSession(db, session.tokenHash);
    reply.header('Set-Cookie', `mark_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${options.secureCookie ? '; Secure' : ''}`);
    return { authenticated: false };
  });

  app.get('/api/settings/sync', async () => ({ intervalMinutes: syncIntervalMinutes(db) }));
  app.patch('/api/settings/sync', async (request, reply) => {
    const parsed = z.object({ intervalMinutes: z.union([
      z.literal(0), z.literal(15), z.literal(30), z.literal(60), z.literal(180), z.literal(360), z.literal(1440),
    ]) }).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '同步频率无效');
    saveSyncIntervalMinutes(db, parsed.data.intervalMinutes);
    return { intervalMinutes: syncIntervalMinutes(db) };
  });

  app.get('/api/sources/preview', async (request, reply) => {
    const url = (request.query as { url?: string }).url;
    if (!url) return error(reply, 400, 'INVALID_URL', '请输入 GitHub 仓库地址');
    try {
      const preview = await previewGitHubSource(url);
      const existing = db.prepare('SELECT id, enabled FROM sources WHERE url = ?').get(preview.url) as { id: number; enabled: number } | undefined;
      return { ...preview, existing: existing ? { id: existing.id, active: Boolean(existing.enabled) } : null };
    } catch (cause) {
      return error(reply, 400, 'SOURCE_UNAVAILABLE', cause instanceof Error ? cause.message : '无法访问仓库', true);
    }
  });
  app.get('/api/sources', async () => sourceView(db));
  app.get('/api/library/recent', async () => db.prepare(`SELECT d.id, d.title, d.path, s.name AS sourceName,
    r.state, r.position, r.updated_at AS updatedAt FROM reading_states r
    JOIN documents d ON d.id = r.document_id JOIN sources s ON s.id = d.source_id
    WHERE d.status = 'current' AND s.enabled = 1 ORDER BY r.updated_at DESC, r.rowid DESC LIMIT 6`).all());
  app.post('/api/sources', async (request, reply) => {
    const parsed = z.object({ url: z.string().min(1), name: z.string().trim().max(80).optional(), restore: z.boolean().optional() }).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '来源信息无效');
    try {
      const preview = await previewGitHubSource(parsed.data.url);
      const existing = db.prepare('SELECT id, enabled FROM sources WHERE url = ?').get(preview.url) as { id: number; enabled: number } | undefined;
      let id: number;
      if (existing?.enabled) return error(reply, 409, 'DUPLICATE_SOURCE', '这个来源已经在书架中');
      if (existing && !parsed.data.restore) return error(reply, 409, 'RESTORE_REQUIRED', '这个来源已移除，可以选择恢复');
      if (existing) {
        id = existing.id;
        db.prepare('UPDATE sources SET enabled = 1, sync_enabled = 1, name = ?, branch = ?, sync_status = ? WHERE id = ?')
          .run(parsed.data.name || preview.name, preview.branch, 'queued', id);
      } else {
        const result = db.prepare('INSERT INTO sources(name, url, branch) VALUES (?, ?, ?)')
          .run(parsed.data.name || preview.name, preview.url, preview.branch);
        id = Number(result.lastInsertRowid);
      }
      const runId = queueSync(db, options.dataDir, id);
      return reply.code(202).send({ id, runId });
    } catch (cause) {
      return error(reply, 400, 'SOURCE_UNAVAILABLE', cause instanceof Error ? cause.message : '无法访问仓库', true);
    }
  });
  app.patch('/api/sources/:id', async (request, reply) => {
    const id = routeId(request);
    const parsed = z.object({ name: z.string().trim().min(1).max(80).optional(), syncEnabled: z.boolean().optional() })
      .refine((value) => value.name !== undefined || value.syncEnabled !== undefined).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '来源设置无效');
    const result = db.prepare('UPDATE sources SET name = COALESCE(?, name), sync_enabled = COALESCE(?, sync_enabled) WHERE id = ? AND enabled = 1')
      .run(parsed.data.name ?? null, parsed.data.syncEnabled === undefined ? null : Number(parsed.data.syncEnabled), id);
    return result.changes ? { id, ...parsed.data } : error(reply, 404, 'NOT_FOUND', '来源不存在');
  });
  app.delete('/api/sources/:id', async (request, reply) => {
    const id = routeId(request);
    const result = db.prepare('UPDATE sources SET enabled = 0 WHERE id = ? AND enabled = 1').run(id);
    return result.changes ? { id, retained: true } : error(reply, 404, 'NOT_FOUND', '来源不存在');
  });
  app.post('/api/sources/:id/sync', async (request, reply) => {
    try {
      const runId = queueSync(db, options.dataDir, routeId(request));
      return reply.code(202).send({ runId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '来源不存在';
      return error(reply, message.includes('暂停') ? 409 : 404, message.includes('暂停') ? 'SOURCE_PAUSED' : 'NOT_FOUND', message);
    }
  });
  app.get('/api/sync-runs/:id', async (request, reply) => {
    const run = db.prepare('SELECT id, source_id AS sourceId, from_sha AS fromSha, to_sha AS toSha, status, stage, error, started_at AS startedAt, finished_at AS finishedAt FROM sync_runs WHERE id = ?')
      .get(routeId(request));
    return run ?? error(reply, 404, 'NOT_FOUND', '同步任务不存在');
  });
  app.get('/api/sources/:id/documents', async (request, reply) => {
    const id = routeId(request);
    const source = db.prepare('SELECT id, name, published_sha AS publishedSha, sync_status AS syncStatus FROM sources WHERE id = ? AND enabled = 1').get(id);
    if (!source) return error(reply, 404, 'NOT_FOUND', '来源不存在');
    const documents = db.prepare("SELECT id, path, title, current_sha AS currentSha FROM documents WHERE source_id = ? AND status = 'current' ORDER BY path")
      .all(id);
    return { source, documents };
  });
  app.get('/api/documents/:id', async (request, reply) => {
    const id = routeId(request);
    const row = db.prepare(`SELECT d.id, d.source_id AS sourceId, d.path, d.title, d.current_sha AS currentSha, d.status,
      s.name AS sourceName, s.published_sha AS publishedSha FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = ? AND s.enabled = 1`).get(id) as
      | { id: number; sourceId: number; path: string; title: string; currentSha: string; status: string; sourceName: string; publishedSha: string }
      | undefined;
    if (!row) return error(reply, 404, 'NOT_FOUND', '文档不存在');
    if (row.status !== 'current') return error(reply, 410, 'REMOVED', '文档已从来源移除');
    try {
      const markdown = (await readTreeFile(mirrorPath(options.dataDir, row.sourceId), row.publishedSha, row.path)).toString('utf8');
      return { ...row, markdown, plainText: summarizeMarkdown(markdown, row.path).body };
    } catch {
      return error(reply, 503, 'CONTENT_UNAVAILABLE', '暂时无法读取文档，请重试', true);
    }
  });
  app.get('/api/documents/:id/assets', async (request, reply) => {
    const id = routeId(request);
    const row = db.prepare(`SELECT d.path, d.source_id AS sourceId, s.published_sha AS publishedSha FROM documents d JOIN sources s ON s.id = d.source_id
      WHERE d.id = ? AND d.status = 'current' AND s.enabled = 1`).get(id) as { path: string; sourceId: number; publishedSha: string } | undefined;
    if (!row) return error(reply, 404, 'NOT_FOUND', '文档不存在');
    const rawPath = (request.query as { path?: string }).path;
    if (!rawPath || rawPath.startsWith('/') || rawPath.includes('://')) return error(reply, 400, 'INVALID_PATH', '资源路径无效');
    const path = posix.normalize(posix.join(posix.dirname(row.path), rawPath));
    if (!safeTreePath(path)) return error(reply, 400, 'INVALID_PATH', '资源路径无效');
    try {
      const bytes = await readAsset(mirrorPath(options.dataDir, row.sourceId), row.publishedSha, path);
      const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      reply.type(mime[extname(path).toLowerCase()] ?? 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.send(bytes);
    } catch {
      return error(reply, 404, 'ASSET_MISSING', '资源不存在');
    }
  });
  app.get('/api/documents/:id/personal', async (request, reply) => {
    const id = routeId(request);
    const visible = db.prepare('SELECT 1 FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = ? AND s.enabled = 1').get(id);
    if (!visible) return error(reply, 404, 'NOT_FOUND', '文档不存在');
    const reading = db.prepare('SELECT state, position, updated_at AS updatedAt FROM reading_states WHERE document_id = ?').get(id) ?? { state: 'unread', position: 0, updatedAt: null };
    const bookmarked = Boolean(db.prepare('SELECT 1 FROM bookmarks WHERE document_id = ?').get(id));
    const annotations = db.prepare('SELECT id, kind, note, color, exact, prefix, suffix, start_offset AS startOffset, end_offset AS endOffset, anchor_status AS anchorStatus, created_at AS createdAt FROM annotations WHERE document_id = ? ORDER BY id DESC').all(id);
    return { reading, bookmarked, annotations };
  });
  app.put('/api/documents/:id/reading', async (request, reply) => {
    const id = routeId(request);
    const parsed = z.object({ position: z.number().min(0).max(1), state: z.enum(['unread', 'reading', 'completed']).optional() }).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '阅读状态无效');
    const visible = db.prepare("SELECT 1 FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = ? AND d.status = 'current' AND s.enabled = 1").get(id);
    if (!visible) return error(reply, 404, 'NOT_FOUND', '文档不存在');
    const existing = db.prepare('SELECT state FROM reading_states WHERE document_id = ?').get(id) as { state: string } | undefined;
    const state = parsed.data.state ?? (existing?.state === 'completed' ? 'completed' : 'reading');
    db.prepare(`INSERT INTO reading_states(document_id, state, position) VALUES (?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET state = excluded.state, position = excluded.position, updated_at = CURRENT_TIMESTAMP`)
      .run(id, state, parsed.data.position);
    return { state, position: parsed.data.position };
  });
  app.put('/api/documents/:id/bookmark', async (request, reply) => {
    const id = routeId(request);
    const parsed = z.object({ bookmarked: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '书签状态无效');
    if (parsed.data.bookmarked) db.prepare('INSERT OR IGNORE INTO bookmarks(document_id) VALUES (?)').run(id);
    else db.prepare('DELETE FROM bookmarks WHERE document_id = ?').run(id);
    return { bookmarked: parsed.data.bookmarked };
  });
  app.post('/api/annotations', async (request, reply) => {
    const parsed = z.object({ documentId: z.number().int().positive(), exact: z.string().trim().min(1).max(5_000), note: z.string().max(20_000).default(''), color: z.enum(['yellow', 'green', 'pink', 'blue']).default('green'), approxOffset: z.number().int().min(0).optional() }).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '标注内容无效');
    const document = db.prepare(`SELECT d.id, d.path, d.source_id AS sourceId, s.published_sha AS sha FROM documents d JOIN sources s ON s.id = d.source_id
      WHERE d.id = ? AND d.status = 'current' AND s.enabled = 1`).get(parsed.data.documentId) as { id: number; path: string; sourceId: number; sha: string } | undefined;
    if (!document) return error(reply, 404, 'NOT_FOUND', '文档不存在');
    const markdown = (await readTreeFile(mirrorPath(options.dataDir, document.sourceId), document.sha, document.path)).toString('utf8');
    const plainText = summarizeMarkdown(markdown, document.path).body;
    const exact = parsed.data.exact.replace(/\s+/g, ' ');
    const positions: number[] = [];
    for (let index = plainText.indexOf(exact); index >= 0; index = plainText.indexOf(exact, index + Math.max(1, exact.length))) positions.push(index);
    if (!positions.length) return error(reply, 409, 'TEXT_CHANGED', '选中的文字已变化，请重新选择');
    const index = parsed.data.approxOffset === undefined ? positions[0] : positions.sort((a, b) => Math.abs(a - parsed.data.approxOffset!) - Math.abs(b - parsed.data.approxOffset!))[0];
    const prefix = plainText.slice(Math.max(0, index - 24), index);
    const suffix = plainText.slice(index + exact.length, index + exact.length + 24);
    const result = db.prepare(`INSERT INTO annotations(document_id, kind, note, color, exact, prefix, suffix, start_offset, end_offset, created_sha)
      VALUES (?, 'highlight', ?, ?, ?, ?, ?, ?, ?, ?)`).run(document.id, parsed.data.note, parsed.data.color, exact, prefix, suffix, index, index + exact.length, document.sha);
    return reply.code(201).send({ id: Number(result.lastInsertRowid) });
  });
  app.patch('/api/annotations/:id', async (request, reply) => {
    const id = routeId(request);
    const parsed = z.object({ note: z.string().max(20_000).optional(), color: z.enum(['yellow', 'green', 'pink', 'blue']).optional(), exact: z.string().trim().min(1).max(5_000).optional() }).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '标注内容无效');
    const current = db.prepare(`SELECT a.id, a.document_id AS documentId, d.path, d.status AS documentStatus,
      d.source_id AS sourceId, s.published_sha AS sha, s.enabled AS sourceEnabled FROM annotations a
      JOIN documents d ON d.id = a.document_id JOIN sources s ON s.id = d.source_id WHERE a.id = ?`).get(id) as
      { id: number; documentId: number; path: string; documentStatus: string; sourceId: number; sha: string; sourceEnabled: number } | undefined;
    if (!current) return error(reply, 404, 'NOT_FOUND', '标注不存在');
    if (parsed.data.exact) {
      if (!current.sourceEnabled || current.documentStatus !== 'current') return error(reply, 409, 'DOCUMENT_REMOVED', '原文已移除，无法重新定位');
      const markdown = (await readTreeFile(mirrorPath(options.dataDir, current.sourceId), current.sha, current.path)).toString('utf8');
      const body = summarizeMarkdown(markdown, current.path).body;
      const exact = parsed.data.exact.replace(/\s+/g, ' ');
      const index = body.indexOf(exact);
      if (index < 0 || body.indexOf(exact, index + 1) >= 0) return error(reply, 409, 'ANCHOR_AMBIGUOUS', '新位置不唯一，请选择更长的文字');
      db.prepare(`UPDATE annotations SET exact = ?, prefix = ?, suffix = ?, start_offset = ?, end_offset = ?, created_sha = ?, anchor_status = 'anchored', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(exact, body.slice(Math.max(0, index - 24), index), body.slice(index + exact.length, index + exact.length + 24), index, index + exact.length, current.sha, id);
    }
    if (parsed.data.note !== undefined || parsed.data.color !== undefined) {
      db.prepare('UPDATE annotations SET note = COALESCE(?, note), color = COALESCE(?, color), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(parsed.data.note ?? null, parsed.data.color ?? null, id);
    }
    return { id };
  });
  app.delete('/api/annotations/:id', async (request, reply) => {
    const result = db.prepare('DELETE FROM annotations WHERE id = ?').run(routeId(request));
    return result.changes ? { deleted: true } : error(reply, 404, 'NOT_FOUND', '标注不存在');
  });
  app.get('/api/marks', async () => {
    const annotations = db.prepare(`SELECT a.id, a.document_id AS documentId, a.note, a.color, a.exact, a.anchor_status AS anchorStatus,
      a.created_at AS createdAt, d.title, d.path, d.status AS documentStatus, s.name AS sourceName, s.enabled AS sourceEnabled FROM annotations a
      JOIN documents d ON d.id = a.document_id JOIN sources s ON s.id = d.source_id ORDER BY a.id DESC`).all();
    const bookmarks = db.prepare(`SELECT b.document_id AS documentId, b.created_at AS createdAt, d.title, d.path,
      d.status AS documentStatus, s.name AS sourceName, s.enabled AS sourceEnabled FROM bookmarks b
      JOIN documents d ON d.id = b.document_id JOIN sources s ON s.id = d.source_id ORDER BY b.created_at DESC`).all();
    return { annotations, bookmarks };
  });
  app.get('/api/updates', async (request) => {
    const sourceId = Number((request.query as { sourceId?: string }).sourceId ?? 0);
    const runs = db.prepare(`SELECT r.id, r.source_id AS sourceId, s.name AS sourceName, r.from_sha AS fromSha, r.to_sha AS toSha,
      r.finished_at AS finishedAt FROM sync_runs r JOIN sources s ON s.id = r.source_id
      WHERE r.status = 'success' AND (? = 0 OR s.id = ?) ORDER BY r.id DESC LIMIT 50`).all(sourceId, sourceId);
    const changes = db.prepare(`SELECT c.sync_run_id AS runId, c.document_id AS documentId, c.old_path AS oldPath, c.new_path AS newPath,
      c.kind, d.title FROM document_changes c JOIN documents d ON d.id = c.document_id
      WHERE c.sync_run_id = ? ORDER BY c.id`);
    return (runs as Array<{ id: number }>).map((run) => ({ ...run, changes: changes.all(run.id) }));
  });
  app.get('/api/updates/:id/diff', async (request, reply) => {
    const runId = routeId(request);
    const documentId = Number((request.query as { documentId?: string }).documentId);
    if (!Number.isSafeInteger(documentId) || documentId <= 0) return error(reply, 400, 'INVALID_INPUT', '文档标识无效');
    const change = db.prepare(`SELECT c.kind, c.old_path AS oldPath, c.new_path AS newPath,
      r.from_sha AS fromSha, r.to_sha AS toSha, r.source_id AS sourceId, d.title, s.name AS sourceName
      FROM document_changes c JOIN sync_runs r ON r.id = c.sync_run_id
      JOIN documents d ON d.id = c.document_id JOIN sources s ON s.id = r.source_id
      WHERE c.sync_run_id = ? AND c.document_id = ? AND r.status = 'success'`).get(runId, documentId) as
      | { kind: string; oldPath: string | null; newPath: string | null; fromSha: string | null; toSha: string; sourceId: number; title: string; sourceName: string }
      | undefined;
    if (!change) return error(reply, 404, 'NOT_FOUND', '更新记录不存在');
    try {
      const repo = mirrorPath(options.dataDir, change.sourceId);
      const before = change.fromSha && change.oldPath ? (await readTreeFile(repo, change.fromSha, change.oldPath)).toString('utf8') : '';
      const after = change.newPath ? (await readTreeFile(repo, change.toSha, change.newPath)).toString('utf8') : '';
      return { ...change, before, after, documentId, runId };
    } catch {
      return error(reply, 503, 'VERSION_UNAVAILABLE', '暂时无法读取历史版本，请重试', true);
    }
  });
  app.get('/api/search', async (request, reply) => {
    const params = request.query as { q?: string; sourceId?: string };
    const q = String(params.q ?? '').trim();
    const sourceId = params.sourceId ? Number(params.sourceId) : null;
    if (sourceId !== null && (!Number.isInteger(sourceId) || sourceId <= 0)) return error(reply, 400, 'INVALID_QUERY', '来源筛选无效');
    if (q.length < 2) return { query: q, results: [] };
    if (q.length > 100) return error(reply, 400, 'INVALID_QUERY', '关键词过长');
    const escaped = q.replace(/[\\%_]/g, (char) => `\\${char}`);
    const pattern = `%${escaped}%`;
    const rows = db.prepare(`SELECT ds.document_id AS id, d.title, d.path, s.id AS sourceId, s.name AS sourceName,
      s.published_sha AS publishedSha, ds.body
      FROM document_search ds JOIN documents d ON d.id = ds.document_id JOIN sources s ON s.id = d.source_id
      WHERE d.status = 'current' AND s.enabled = 1 AND (? IS NULL OR s.id = ?)
        AND (ds.title LIKE ? ESCAPE '\\' OR ds.body LIKE ? ESCAPE '\\')
      LIMIT 50`).all(sourceId, sourceId, pattern, pattern) as Array<{ id: number; title: string; path: string; sourceId: number; sourceName: string; publishedSha: string; body: string }>;
    return { query: q, results: rows.map(({ body, ...row }) => {
      const index = body.toLowerCase().indexOf(q.toLowerCase());
      return { ...row, snippet: body.slice(Math.max(0, index - 45), Math.max(0, index - 45) + 150) };
    }) };
  });
  app.get('/api/ask/status', async () => ({ configured: askConfigured(options.model ?? {}), model: options.model?.model ?? null }));
  app.post('/api/ask', async (request, reply) => {
    const parsed = z.object({ question: z.string().trim().min(2).max(1_000), documentId: z.number().int().positive().optional() }).safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_INPUT', '请输入问题');
    try {
      return await answerQuestion(db, options.model ?? {}, parsed.data.question, parsed.data.documentId);
    } catch (cause) {
      if (cause instanceof AskFailure) return error(reply, cause.status, cause.code, cause.message, cause.status >= 500);
      return error(reply, 503, 'MODEL_UNAVAILABLE', '问答暂时不可用，请稍后重试', true);
    }
  });

  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: options.webDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return error(reply, 404, 'NOT_FOUND', '接口不存在');
      return reply.sendFile('index.html');
    });
  }
  return { app, db };
}
