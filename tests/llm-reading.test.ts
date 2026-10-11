import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { buildApp } from '../server/app.ts';
import { fetchSource, mirrorPath } from '../server/git.ts';
import { publishSnapshot } from '../server/sync.ts';
import { explainUpdate } from '../server/ask.ts';
import type { ModelConfig } from '../server/model-client.ts';

const original = '# Learning Guide\n\nLearning alpha. Old setting 10.\n\nRepeated quote.\n\nRepeated quote.\n\n![image](picture.png)\n';
const reply = (content = '解释依据原文。[1]') => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
async function fixture(fetcher?: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'mark-reading-llm-'));
  const password = join(root, 'password'); writeFileSync(password, 'reading-fixture-password');
  const calls: Array<{ body: { messages: Array<{ content: string }> }; signal?: AbortSignal | null }> = [];
  const model: ModelConfig = { baseUrl: 'https://example.invalid/v1', model: 'fixture', fetcher: async (url, options) => {
    calls.push({ body: JSON.parse(options!.body as string), signal: options?.signal });
    return fetcher ? fetcher(url, options) : reply();
  } };
  const { app, db } = await buildApp({ dataDir: root, initialPasswordFile: password, model });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'reading-fixture-password' } });
  const headers = { cookie: login.headers['set-cookie'] as string, 'x-csrf-token': login.json().csrf as string };
  mkdirSync(join(root, 'repos'));
  const repo = join(root, 'fixture');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Mark Reading Test');
  writeFileSync(join(repo, 'guide.md'), original);
  writeFileSync(join(repo, 'other.md'), '# Another\n\nSAME_SOURCE_ONLY alpha.\n');
  writeFileSync(join(repo, 'picture.png'), 'old-image');
  git('add', '.'); git('commit', '-qm', 'first');
  execFileSync('git', ['clone', '--bare', '-q', repo, mirrorPath(root, 1)]);
  db.prepare("INSERT INTO sources(id, name, url, branch) VALUES (1, 'Primary', 'https://github.com/test/primary.git', 'main')").run();
  const firstSha = git('rev-parse', 'HEAD');
  let runId = Number(db.prepare("INSERT INTO sync_runs(source_id, status, stage) VALUES (1, 'running', 'indexing')").run().lastInsertRowid);
  await publishSnapshot(db, 1, runId, mirrorPath(root, 1), firstSha);
  const documentId = Number((db.prepare("SELECT id FROM documents WHERE source_id = 1 AND path = 'guide.md'").get() as { id: number }).id);
  db.prepare("INSERT INTO sources(id, name, url, branch, published_sha) VALUES (2, 'Secondary', 'https://github.com/test/secondary.git', 'main', ?)").run('b'.repeat(40));
  db.prepare("INSERT INTO documents(id, source_id, path, title, current_sha, content_hash) VALUES (3, 2, 'beta.md', 'Beta', ?, 'hash')").run('b'.repeat(40));
  db.prepare("INSERT INTO document_search(title, body, document_id, source_id) VALUES ('Beta', 'BETA_ONLY alpha.', 3, 2)").run();
  async function publish(change: () => void) {
    const fromSha = (db.prepare('SELECT published_sha AS sha FROM sources WHERE id = 1').get() as { sha: string }).sha;
    change(); git('add', '-A'); git('commit', '-qm', 'update ' + ++runId);
    execFileSync('git', ['-C', mirrorPath(root, 1), 'fetch', '-q', repo, 'main']);
    const sha = git('rev-parse', 'HEAD');
    const id = Number(db.prepare("INSERT INTO sync_runs(source_id, from_sha, status, stage) VALUES (1, ?, 'running', 'indexing')").run(fromSha).lastInsertRowid);
    await publishSnapshot(db, 1, id, mirrorPath(root, 1), sha);
    return { sha, runId: id };
  }
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, payload });
  return { root, repo, git, app, db, calls, model, headers, firstSha, documentId, publish, post,
    get: (url: string) => app.inject({ url, headers }),
    ask: (extra: Record<string, unknown> = {}) => post('/api/ask', { question: 'alpha', scope: 'document', documentId, publishedSha: firstSha, ...extra }),
    explain: (extra: Record<string, unknown> = {}) => post(`/api/documents/${documentId}/explain`, { publishedSha: firstSha, exact: 'Old setting 10.', ...extra }),
    version: (sha = firstSha, path = 'guide.md') => app.inject({ url: `/api/documents/${documentId}/version?${new URLSearchParams({ sha, path })}`, headers }),
    close: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('Reader Ask stays within one document and cross-source Ask uses only explicitly selected sources', async () => {
  const f = await fixture();
  try {
    const result = await f.ask(); assert.equal(result.statusCode, 200);
    const sent = JSON.stringify(f.calls[0].body);
    assert.equal(sent.includes('SAME SOURCE ONLY'), false); assert.equal(sent.includes('BETA_ONLY'), false);
    assert.equal(result.json().citations[0].documentId, f.documentId);
    const selected = await f.post('/api/ask', { question: 'alpha', scope: 'sources', sourceIds: [2] });
    assert.equal(selected.statusCode, 200);
    assert.equal(JSON.stringify(f.calls[1].body).includes('Old setting'), false);
    assert.equal(selected.json().citations[0].sourceId, 2);
    for (const payload of [{ question: 'alpha' }, { question: 'alpha', scope: 'sources' }, { question: 'alpha', scope: 'sources', sourceIds: [1, 1] }, { question: 'alpha', scope: 'sources', sourceIds: [1], documentId: f.documentId }]) {
      assert.equal((await f.post('/api/ask', payload)).statusCode, 400);
    }
    assert.equal((await f.post('/api/ask', { question: 'alpha', scope: 'sources', sourceIds: [99] })).statusCode, 410);
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('generation snapshots survive publication changes and citations open the original text and assets without writes', async () => {
  let complete!: () => void;
  const f = await fixture(async () => { await new Promise<void>(resolve => { complete = resolve; }); return reply(); });
  try {
    const pending = f.ask(); while (!f.calls.length) await new Promise(resolve => setTimeout(resolve, 5));
    const next = await f.publish(() => { writeFileSync(join(f.repo, 'guide.md'), '# New Guide\n\nLearning alpha. New setting 20.\n'); writeFileSync(join(f.repo, 'picture.png'), 'new-image'); });
    complete(); const answer = (await pending).json();
    assert.equal(answer.citations[0].publishedSha, f.firstSha);
    const before = (await f.get(`/api/documents/${f.documentId}/personal`)).body;
    const old = await f.version(); assert.equal(old.statusCode, 200); assert.equal(old.json().isCurrent, false); assert.equal(old.json().markdown, original);
    const asset = await f.get(`/api/documents/${f.documentId}/version/assets?${new URLSearchParams({ sha: f.firstSha, path: 'guide.md', asset: 'picture.png' })}`);
    assert.equal(asset.body, 'old-image');
    assert.equal((await f.get(`/api/documents/${f.documentId}/personal`)).body, before);
    assert.equal((await f.version(next.sha)).json().markdown.includes('New setting 20.'), true);
  } finally { await f.close(); }
});

test('already displayed versions still support Ask and selection after document deletion; removed sources stop new calls but retain citations', async () => {
  const f = await fixture();
  try {
    await f.publish(() => rmSync(join(f.repo, 'guide.md')));
    assert.equal((await f.ask()).statusCode, 200); assert.equal((await f.explain()).statusCode, 200);
    f.db.prepare('UPDATE sources SET enabled = 0 WHERE id = 1').run();
    assert.equal((await f.version()).statusCode, 200); assert.equal((await f.version()).json().sourceEnabled, false);
    assert.equal((await f.ask()).statusCode, 410); assert.equal((await f.explain()).statusCode, 410);
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('version lookup tracks renames, unchanged snapshots, deletion and re-addition; unrelated paths and commits are rejected', async () => {
  const f = await fixture();
  try {
    const unchanged = await f.publish(() => writeFileSync(join(f.repo, 'other.md'), '# Another\n\nChanged other file.\n'));
    assert.equal((await f.version(unchanged.sha)).statusCode, 200);
    const renamed = await f.publish(() => renameSync(join(f.repo, 'guide.md'), join(f.repo, 'renamed.md')));
    assert.equal((await f.version(renamed.sha, 'renamed.md')).statusCode, 200);
    assert.equal((await f.version(renamed.sha, 'guide.md')).statusCode, 404);
    assert.equal((await f.version()).json().path, 'guide.md');
    const deleted = await f.publish(() => rmSync(join(f.repo, 'renamed.md')));
    assert.equal((await f.version(deleted.sha, 'renamed.md')).statusCode, 404);
    assert.equal((await f.version(renamed.sha, 'renamed.md')).statusCode, 200);
    assert.equal((await f.version('a'.repeat(40))).statusCode, 404);
    assert.equal((await f.version(f.firstSha, '../guide.md')).statusCode, 400);
    assert.equal((await f.version(f.firstSha, 'other.md')).statusCode, 404);
    const readded = await f.publish(() => writeFileSync(join(f.repo, 'renamed.md'), original));
    assert.equal((await f.version(readded.sha, 'renamed.md')).statusCode, 200);
  } finally { await f.close(); }
});

test('repository replacement preserves old version citations and missing Git storage fails explicitly', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE sources SET url = 'https://github.com/test/replacement.git' WHERE id = 1").run();
    const replacement = join(f.root, 'replacement');
    execFileSync('git', ['init', '-q', '-b', 'main', replacement]);
    const otherGit = (...args: string[]) => execFileSync('git', args, { cwd: replacement });
    otherGit('config', 'user.email', 'test@example.invalid'); otherGit('config', 'user.name', 'Replacement Fixture');
    writeFileSync(join(replacement, 'guide.md'), '# Replacement\n\nIndependent repository snapshot.\n');
    otherGit('add', '.'); otherGit('commit', '-qm', 'independent first commit');
    const next = await fetchSource(f.root, 1, replacement, 'main');
    const runId = Number(f.db.prepare("INSERT INTO sync_runs(source_id, from_sha, status, stage) VALUES (1, ?, 'running', 'indexing')").run(f.firstSha).lastInsertRowid);
    await publishSnapshot(f.db, 1, runId, next.repo, next.sha);
    assert.equal((await f.version()).json().markdown, original);
    assert.equal((await f.version(next.sha)).json().markdown.includes('Independent repository'), true);
    renameSync(mirrorPath(f.root, 1), mirrorPath(f.root, 1) + '.unavailable');
    const result = await f.version(); assert.equal(result.statusCode, 503); assert.equal(result.json().code, 'VERSION_UNAVAILABLE');
  } finally { await f.close(); }
});

test('selection checks exact version, rejects empty/long/unknown/ambiguous selections and sends no unrelated evidence', async () => {
  const f = await fixture();
  try {
    for (const extra of [{ exact: '' }, { exact: 'x'.repeat(2001) }, { exact: 'invented text' }, { exact: 'Repeated quote.' }]) assert.equal((await f.explain(extra)).statusCode, 400);
    assert.equal(f.calls.length, 0);
    const result = await f.explain({ exact: 'Repeated quote.', approxOffset: original.indexOf('Repeated quote.') });
    assert.equal(result.statusCode, 200);
    const sent = JSON.stringify(f.calls[0].body); assert.equal(sent.includes('BETA_ONLY'), false); assert.equal(sent.includes('SAME SOURCE ONLY'), false);
    await f.publish(() => writeFileSync(join(f.repo, 'guide.md'), '# Learning\n\nNew selected phrase.\n'));
    assert.equal((await f.explain()).statusCode, 200);
    assert.equal((await f.explain({ exact: 'New selected phrase.' })).statusCode, 400);
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('update explanation uses the requested before/after snapshots, actual mark excerpts and never edits personal records', async () => {
  const f = await fixture();
  try {
    await f.post('/api/annotations', { documentId: f.documentId, exact: 'Old setting 10.', note: 'PRIVATE_NOTE_NOT_SENT', color: 'green' });
    const second = await f.publish(() => writeFileSync(join(f.repo, 'guide.md'), '# Learning Guide\n\nLearning alpha. New setting 20.\n'));
    const personalBefore = (await f.get(`/api/documents/${f.documentId}/personal`)).body;
    const result = await f.post(`/api/updates/${second.runId}/explain`, { documentId: f.documentId });
    assert.equal(result.statusCode, 200); assert.equal(result.json().reviewMarks.length, 1);
    const sent = JSON.stringify(f.calls[0].body); assert.equal(sent.includes('Old setting 10.'), true); assert.equal(sent.includes('New setting 20.'), true);
    assert.equal(sent.includes('PRIVATE_NOTE_NOT_SENT'), false);
    assert.equal((await f.get(`/api/documents/${f.documentId}/personal`)).body, personalBefore);
    await f.publish(() => writeFileSync(join(f.repo, 'guide.md'), '# Future heading\n\nFuture content.\n'));
    assert.equal((await f.post(`/api/updates/${second.runId}/explain`, { documentId: f.documentId })).statusCode, 200);
    assert.equal(JSON.stringify(f.calls[1].body).includes('Future content'), false);
  } finally { await f.close(); }
});

test('added/deleted/renamed update explanations cite only existing sides; invalid update IDs do not call a model', async () => {
  const f = await fixture();
  try {
    const added = await f.post('/api/updates/1/explain', { documentId: f.documentId });
    assert.equal(added.statusCode, 200); assert.equal(added.json().citations.every((item: { publishedSha: string }) => item.publishedSha === f.firstSha), true);
    const renamed = await f.publish(() => renameSync(join(f.repo, 'guide.md'), join(f.repo, 'renamed.md')));
    assert.equal((await f.post(`/api/updates/${renamed.runId}/explain`, { documentId: f.documentId })).statusCode, 200);
    assert.equal(JSON.stringify(f.calls[1].body).includes('仅重命名不得宣称正文含义改变'), true);
    const deleted = await f.publish(() => rmSync(join(f.repo, 'renamed.md')));
    const result = await f.post(`/api/updates/${deleted.runId}/explain`, { documentId: f.documentId });
    assert.equal(result.statusCode, 200); assert.equal(result.json().citations.every((item: { publishedSha: string }) => item.publishedSha === renamed.sha), true);
    assert.equal((await f.post('/api/updates/999/explain', { documentId: f.documentId })).statusCode, 404);
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test('large update coverage is explicitly partial and bounded; original full diff remains readable', async () => {
  const f = await fixture();
  try {
    const next = await f.publish(() => writeFileSync(join(f.repo, 'guide.md'), '# Long guide\n\n' + 'Changed content and facts. '.repeat(1200)));
    const result = await f.post(`/api/updates/${next.runId}/explain`, { documentId: f.documentId });
    assert.equal(result.statusCode, 200); assert.match(result.json().contextNote, /部分/);
    assert.ok(JSON.stringify(f.calls[0].body).length < 20000);
    assert.ok((await f.get(`/api/updates/${next.runId}/diff?documentId=${f.documentId}`)).json().after.length > 20000);
  } finally { await f.close(); }
});

test('new model endpoints preserve login/CSRF and show missing model and invalid citation without writes', async () => {
  const f = await fixture(async () => reply('No valid citation [99]'));
  try {
    assert.equal((await f.app.inject(`/api/documents/${f.documentId}/version?sha=${f.firstSha}`)).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/documents/${f.documentId}/explain`, headers: { cookie: f.headers.cookie }, payload: { publishedSha: f.firstSha, exact: 'Old setting 10.' } })).statusCode, 403);
    assert.equal((await f.explain()).json().code, 'INVALID_CITATION');
    assert.equal((await f.post('/api/updates/1/explain', { documentId: f.documentId })).json().code, 'INVALID_CITATION');
    await f.app.inject({ method: 'PATCH', url: '/api/settings/model', headers: f.headers, payload: { enabled: false, baseUrl: '', model: '', clearApiKey: true, revision: 0 } });
    assert.equal((await f.explain()).json().code, 'MODEL_NOT_CONFIGURED');
    assert.equal((await f.post('/api/updates/1/explain', { documentId: f.documentId })).json().code, 'MODEL_NOT_CONFIGURED');
    assert.equal(f.calls.length, 2); assert.equal((await f.get(`/api/documents/${f.documentId}`)).statusCode, 200);
  } finally { await f.close(); }
});

test('caller cancellation reaches model transport and prevents a late update answer', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(async (_, options) => new Promise<Response>((resolve, reject) => {
    started(); options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
  }));
  try {
    const controller = new AbortController();
    const pending = explainUpdate(f.db, f.root, f.model, 1, f.documentId, controller.signal);
    await ready; controller.abort();
    await assert.rejects(pending, (cause: unknown) => (cause as { code: string }).code === 'MODEL_CANCELLED');
    assert.equal(f.calls[0].signal?.aborted, true);
  } finally { await f.close(); }
});
