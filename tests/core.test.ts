import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../server/app.ts';
import { answerQuestion, AskFailure } from '../server/ask.ts';
import { openDatabase } from '../server/db.ts';
import { mirrorPath, normalizeGitHubUrl } from '../server/git.ts';
import { dueSourceIds } from '../server/settings.ts';
import { publishSnapshot } from '../server/sync.ts';
import { lineChanges } from '../src/diff.ts';

function command(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

test('source addresses accept only canonical public GitHub HTTPS locations', () => {
  assert.equal(normalizeGitHubUrl('https://github.com/ossu/computer-science'), 'https://github.com/ossu/computer-science.git');
  for (const input of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/b/c']) {
    assert.throws(() => normalizeGitHubUrl(input));
  }
});

test('line diff keeps unchanged lines between separate edits clear', () => {
  const diff = lineChanges('start\nold A\nmiddle\nold B\nend', 'start\nnew A\nmiddle\nnew B\nend');
  assert.deepEqual(diff.beforeChanged, [false, true, false, true, false]);
  assert.deepEqual(diff.afterChanged, [false, true, false, true, false]);
  assert.equal(diff.coarse, false);
});

test('published documents and search advance together while personal notes survive changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mark-sync-'));
  const repo = join(root, 'fixture');
  const db = openDatabase(join(root, 'mark.db'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    command(repo, 'config', 'user.email', 'test@example.invalid');
    command(repo, 'config', 'user.name', 'Mark Test');
    writeFileSync(join(repo, 'guide.md'), '# 阅读指南\n\n知识库测试 alpha。\n');
    command(repo, 'add', '.');
    command(repo, 'commit', '-qm', 'first');
    const firstSha = command(repo, 'rev-parse', 'HEAD');
    const sourceId = Number(db.prepare("INSERT INTO sources(name, url, branch) VALUES ('Fixture', 'https://github.com/test/fixture.git', 'main')").run().lastInsertRowid);
    const firstRun = Number(db.prepare("INSERT INTO sync_runs(source_id, status, stage) VALUES (?, 'running', 'indexing')").run(sourceId).lastInsertRowid);
    await publishSnapshot(db, sourceId, firstRun, repo, firstSha);
    const doc = db.prepare('SELECT id, title FROM documents WHERE source_id = ?').get(sourceId) as { id: number; title: string };
    assert.equal(doc.title, '阅读指南');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM document_search WHERE body LIKE ?').get('%知识库测试%') as { count: number }).count, 1);
    db.prepare(`INSERT INTO annotations(document_id, kind, note, exact, prefix, suffix, start_offset, end_offset, created_sha)
      VALUES (?, 'highlight', '我的笔记', '知识库测试', '阅读指南 ', ' alpha。', 5, 10, ?)`).run(doc.id, firstSha);

    writeFileSync(join(repo, 'guide.md'), '# 阅读指南\n\n知识库测试 alpha。新增一段。\n');
    command(repo, 'add', '.');
    command(repo, 'commit', '-qm', 'second');
    const secondSha = command(repo, 'rev-parse', 'HEAD');
    const secondRun = Number(db.prepare("INSERT INTO sync_runs(source_id, from_sha, status, stage) VALUES (?, ?, 'running', 'indexing')").run(sourceId, firstSha).lastInsertRowid);
    await publishSnapshot(db, sourceId, secondRun, repo, secondSha);
    const after = db.prepare('SELECT note, anchor_status AS status FROM annotations WHERE document_id = ?').get(doc.id) as { note: string; status: string };
    assert.equal(after.note, '我的笔记');
    assert.equal(after.status, 'relocated');
    assert.equal((db.prepare('SELECT published_sha AS sha FROM sources WHERE id = ?').get(sourceId) as { sha: string }).sha, secondSha);

    command(repo, 'rm', 'guide.md');
    command(repo, 'commit', '-qm', 'delete');
    const thirdSha = command(repo, 'rev-parse', 'HEAD');
    const thirdRun = Number(db.prepare("INSERT INTO sync_runs(source_id, from_sha, status, stage) VALUES (?, ?, 'running', 'indexing')").run(sourceId, secondSha).lastInsertRowid);
    await publishSnapshot(db, sourceId, thirdRun, repo, thirdSha);
    assert.equal((db.prepare('SELECT status FROM documents WHERE id = ?').get(doc.id) as { status: string }).status, 'deleted');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM document_search WHERE document_id = ?').get(doc.id) as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT note, anchor_status AS status FROM annotations WHERE document_id = ?').get(doc.id) as { note: string; status: string }).status, 'needs_review');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('login is required before reading source data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mark-auth-'));
  const passwordFile = join(root, 'password');
  writeFileSync(passwordFile, 'mark-test-password-123');
  const { app } = await buildApp({ dataDir: root, initialPasswordFile: passwordFile });
  try {
    assert.equal((await app.inject('/api/sources')).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'mark-test-password-123' } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'];
    assert.ok(cookie);
    assert.equal((await app.inject({ method: 'GET', url: '/api/sources', headers: { cookie } })).statusCode, 200);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reader API keeps marks, recent reading, assets, Chinese search and historical diff connected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mark-reader-'));
  const repo = join(root, 'fixture');
  const passwordFile = join(root, 'password');
  let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined;
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    command(repo, 'config', 'user.email', 'test@example.invalid');
    command(repo, 'config', 'user.name', 'Mark Test');
    writeFileSync(join(repo, 'guide.md'), '# 阅读指南\n\n知识学习 alpha。\n\n![图](picture.png)\n');
    writeFileSync(join(repo, 'picture.png'), 'image-bytes');
    command(repo, 'add', '.');
    command(repo, 'commit', '-qm', 'first');
    const firstSha = command(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'guide.md'), '# 阅读指南\n\n知识学习 alpha。新增内容。\n\n![图](picture.png)\n');
    command(repo, 'add', '.');
    command(repo, 'commit', '-qm', 'second');
    const secondSha = command(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(root, 'repos'));
    execFileSync('git', ['clone', '--bare', '-q', repo, mirrorPath(root, 1)]);
    writeFileSync(passwordFile, 'mark-test-password-123');
    const instance = await buildApp({ dataDir: root, initialPasswordFile: passwordFile });
    app = instance.app;
    const db = instance.db;
    db.prepare("INSERT INTO sources(id, name, url, branch) VALUES (1, 'Fixture', 'https://github.com/test/fixture.git', 'main')").run();
    const firstRun = Number(db.prepare("INSERT INTO sync_runs(source_id, status, stage) VALUES (1, 'running', 'indexing')").run().lastInsertRowid);
    await publishSnapshot(db, 1, firstRun, mirrorPath(root, 1), firstSha);
    const doc = db.prepare('SELECT id FROM documents WHERE source_id = 1').get() as { id: number };
    const secondRun = Number(db.prepare("INSERT INTO sync_runs(source_id, from_sha, status, stage) VALUES (1, ?, 'running', 'indexing')").run(firstSha).lastInsertRowid);
    await publishSnapshot(db, 1, secondRun, mirrorPath(root, 1), secondSha);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'mark-test-password-123' } });
    const cookie = login.headers['set-cookie'] as string;
    const csrf = login.json().csrf as string;
    const get = (url: string) => app!.inject({ method: 'GET', url, headers: { cookie } });
    const put = (url: string, payload: Record<string, unknown>) => app!.inject({ method: 'PUT', url, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    assert.equal((await get(`/api/documents/${doc.id}`)).json().markdown.includes('新增内容'), true);
    assert.equal((await get(`/api/documents/${doc.id}/assets?path=picture.png`)).body, 'image-bytes');
    assert.equal((await get('/api/search?q=知识')).json().results[0].id, doc.id);
    assert.equal((await get('/api/search?q=知识&sourceId=1')).json().results[0].id, doc.id);
    assert.equal((await get('/api/search?q=知识&sourceId=2')).json().results.length, 0);
    assert.equal((await get('/api/settings/sync')).json().intervalMinutes, 60);
    assert.deepEqual(dueSourceIds(db, Date.now() + 61 * 60_000), [1]);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings/sync', headers: { cookie, 'x-csrf-token': csrf }, payload: { intervalMinutes: 0 } })).statusCode, 200);
    assert.equal((await get('/api/settings/sync')).json().intervalMinutes, 0);
    assert.deepEqual(dueSourceIds(db, Date.now() + 61 * 60_000), []);
    assert.equal((await put(`/api/documents/${doc.id}/reading`, { position: 0.4 })).statusCode, 200);
    assert.equal((await get('/api/library/recent')).json()[0].position, 0.4);
    assert.equal((await put(`/api/documents/${doc.id}/bookmark`, { bookmarked: true })).statusCode, 200);
    assert.equal((await get('/api/marks')).json().bookmarks[0].documentId, doc.id);
    const mark = await app.inject({ method: 'POST', url: '/api/annotations', headers: { cookie, 'x-csrf-token': csrf }, payload: { documentId: doc.id, exact: '知识学习', note: '测试笔记' } });
    assert.equal(mark.statusCode, 201);
    assert.equal((await get(`/api/documents/${doc.id}/personal`)).json().annotations[0].note, '测试笔记');
    const diff = (await get(`/api/updates/${secondRun}/diff?documentId=${doc.id}`)).json();
    assert.equal(diff.before.includes('新增内容'), false);
    assert.equal(diff.after.includes('新增内容'), true);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/sources/1', headers: { cookie, 'x-csrf-token': csrf }, payload: { syncEnabled: false } })).statusCode, 200);
    assert.equal((await get('/api/sources')).json()[0].syncEnabled, 0);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sources/1/sync', headers: { cookie, 'x-csrf-token': csrf } })).statusCode, 409);
    await assert.rejects(() => answerQuestion(db, {}, '知识学习'), (cause) => cause instanceof AskFailure && cause.code === 'MODEL_NOT_CONFIGURED');
    const answer = await answerQuestion(db, { baseUrl: 'https://example.invalid/v1', model: 'fixture', fetcher: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '文档提到知识学习。[1]' } }] }), { status: 200 }) }, '知识学习');
    assert.equal(answer.citations[0].documentId, doc.id);
    await assert.rejects(() => answerQuestion(db, { baseUrl: 'https://example.invalid/v1', model: 'fixture', fetcher: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '没有依据的答案。[9]' } }] }), { status: 200 }) }, '知识学习'),
    (cause) => cause instanceof AskFailure && cause.code === 'INVALID_CITATION');
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/sources/1', headers: { cookie, 'x-csrf-token': csrf } })).statusCode, 200);
    assert.equal((await get('/api/marks')).json().annotations[0].note, '测试笔记');
    assert.equal((await get('/api/marks')).json().annotations[0].sourceEnabled, 0);
    assert.equal((await get(`/api/updates/${secondRun}/diff?documentId=${doc.id}`)).statusCode, 200);
    assert.equal((await get('/api/search?q=知识')).json().results.length, 0);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
