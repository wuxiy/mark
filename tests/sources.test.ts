import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildApp, type AppOptions } from '../server/app.ts';
import { openDatabase } from '../server/db.ts';
import { mirrorPath, normalizeGitHubUrl, readTreeFile } from '../server/git.ts';

const originalUrl = 'https://github.com/mark-fixture/original.git';
const replacementUrl = 'https://github.com/mark-fixture/replacement.git';
const preview: NonNullable<AppOptions['previewSource']> = async (input) => {
  const url = normalizeGitHubUrl(input);
  return { url, name: url.split('/').at(-1)!.replace(/\.git$/, ''), branch: 'main' };
};

async function fixture(previewSource = preview, seed = true) {
  const root = mkdtempSync(join(tmpdir(), 'mark-source-edit-'));
  const passwordFile = join(root, 'initial-password');
  writeFileSync(passwordFile, 'source-edit-fixture-password');
  const { app, db } = await buildApp({ dataDir: root, initialPasswordFile: passwordFile, previewSource });
  if (seed) {
    db.prepare(`INSERT INTO sources(id, name, url, branch, published_sha, published_url, sync_status)
      VALUES (1, 'Original', ?, 'main', 'old-version', ?, 'ready')`).run(originalUrl, originalUrl);
    db.prepare(`INSERT INTO documents(id, source_id, path, title, current_sha, content_hash)
      VALUES (1, 1, 'guide.md', 'Guide', 'old-version', 'old-hash')`).run();
    addPersonalData(db, 'old-version');
  }
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'source-edit-fixture-password' } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: login.headers['set-cookie'] as string, 'x-csrf-token': login.json().csrf as string };
  return {
    app, db, root, headers,
    get: (url: string) => app.inject({ method: 'GET', url, headers }),
    patch: (payload: Record<string, unknown>, id = 1) => app.inject({ method: 'PATCH', url: `/api/sources/${id}`, headers, payload }),
    sync: () => app.inject({ method: 'POST', url: '/api/sources/1/sync', headers }),
    close: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function addPersonalData(db: DatabaseSync, sha: string) {
  db.prepare(`INSERT INTO annotations(document_id, kind, note, exact, start_offset, end_offset, created_sha)
    VALUES (1, 'highlight', '保留的笔记', 'shared quote', 0, 12, ?)`).run(sha);
  db.prepare("INSERT INTO reading_states(document_id, state, position) VALUES (1, 'reading', 0.4)").run();
  db.prepare('INSERT INTO bookmarks(document_id) VALUES (1)').run();
}

function source(db: DatabaseSync) {
  return db.prepare('SELECT * FROM sources WHERE id = 1').get()!;
}

function personal(db: DatabaseSync) {
  return {
    annotations: db.prepare('SELECT * FROM annotations ORDER BY id').all(),
    reading: db.prepare('SELECT * FROM reading_states ORDER BY document_id').all(),
    bookmarks: db.prepare('SELECT * FROM bookmarks ORDER BY document_id').all(),
  };
}

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('name-only edits and canonical same-repository URLs work offline and retain personal data', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; throw new Error('offline'); });
  try {
    const before = personal(f.db);
    const changed = await f.patch({ name: '  新名称  ', url: 'https://github.com/MARK-FIXTURE/ORIGINAL/' });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().urlChanged, false);
    assert.equal(source(f.db).name, '新名称');
    assert.equal(source(f.db).url, originalUrl);
    assert.equal(source(f.db).published_sha, 'old-version');
    assert.equal(calls, 0);
    assert.deepEqual(personal(f.db), before);
    assert.equal((await f.get('/api/library/recent')).json()[0].sourceName, '新名称');
    assert.equal((await f.get('/api/sources')).json()[0].pendingUrlChange, 0);
  } finally { await f.close(); }
});

test('URL and name save atomically with the new default branch while retaining the published snapshot', async () => {
  const f = await fixture(async (url) => ({ ...await preview(url), branch: 'docs' }));
  try {
    const before = personal(f.db);
    const response = await f.patch({ name: '新仓库', url: replacementUrl.replace(/\.git$/, '/') });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().urlChanged, true);
    const row = source(f.db);
    assert.equal(row.url, replacementUrl);
    assert.equal(row.name, '新仓库');
    assert.equal(row.branch, 'docs');
    assert.equal(row.published_url, originalUrl);
    assert.equal(row.published_sha, 'old-version');
    assert.equal(row.sync_status, 'pending');
    assert.deepEqual(personal(f.db), before);
    assert.equal((await f.get('/api/sources')).json()[0].pendingUrlChange, 1);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()!).n, 0);
    assert.equal((await f.patch({ url: originalUrl })).statusCode, 200);
    assert.equal((await f.get('/api/sources')).json()[0].pendingUrlChange, 0);
  } finally { await f.close(); }
});

test('invalid inputs, duplicate active or removed repositories and inaccessible URLs never partially save', async () => {
  const f = await fixture(async (url) => {
    if (url.includes('/unavailable')) throw new Error('仓库不可访问');
    return preview(url);
  });
  try {
    f.db.prepare("INSERT INTO sources(id, name, url, branch) VALUES (2, 'Other', 'https://github.com/mark-fixture/other.git', 'main')").run();
    f.db.prepare("INSERT INTO sources(id, name, url, branch, enabled) VALUES (3, 'Removed', 'https://github.com/mark-fixture/removed.git', 'main', 0)").run();
    const original = source(f.db);
    for (const payload of [{}, { name: ' ' }, { name: 'a'.repeat(81) }, { syncEnabled: 'false' }, { extra: true }, { url: '' }]) {
      assert.equal((await f.patch(payload)).statusCode, 400);
      assert.deepEqual(source(f.db), original);
    }
    for (const url of ['http://github.com/a/b', 'https://example.invalid/a/b', 'https://github.com/a/b/tree/main']) {
      const invalid = await f.patch({ name: '不能保存', url });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().code, 'INVALID_URL');
      assert.deepEqual(source(f.db), original);
    }
    for (const url of ['https://github.com/MARK-FIXTURE/OTHER/', 'https://github.com/mark-fixture/removed.git']) {
      const duplicate = await f.patch({ name: '不能保存', url });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().code, 'DUPLICATE_SOURCE');
      assert.deepEqual(source(f.db), original);
    }
    const existing = await f.get('/api/sources/preview?url=' + encodeURIComponent('https://github.com/MARK-FIXTURE/OTHER'));
    assert.deepEqual(existing.json().existing, { id: 2, active: true });
    const unavailable = await f.patch({ name: '不能保存', url: 'https://github.com/mark-fixture/unavailable' });
    assert.equal(unavailable.statusCode, 400);
    assert.equal(unavailable.json().code, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(source(f.db), original);
    assert.equal((await f.patch({ url: replacementUrl })).statusCode, 200); // Validation failure released the lock.
    assert.equal((await f.patch({ name: 'Missing' }, 99)).statusCode, 404);
    assert.equal((await f.patch({ name: 'Removed' }, 3)).statusCode, 404);
  } finally { await f.close(); }
});

test('repository validation excludes concurrent URL edits and sync but permits name-only edits', async () => {
  const pending = deferred<Awaited<ReturnType<typeof preview>>>();
  let entered = false;
  const f = await fixture(async () => { entered = true; return pending.promise; });
  let edit: ReturnType<typeof f.patch> | undefined;
  try {
    edit = f.patch({ url: replacementUrl });
    await until(() => entered, 'URL validation started');
    assert.equal((await f.patch({ url: 'https://github.com/mark-fixture/third' })).statusCode, 409);
    const sync = await f.sync();
    assert.equal(sync.statusCode, 409);
    assert.equal(sync.json().code, 'SOURCE_BUSY');
    assert.equal((await f.patch({ name: '允许改名' })).statusCode, 200);
    pending.resolve(await preview(replacementUrl));
    assert.equal((await edit).statusCode, 200);
    assert.equal(source(f.db).name, '允许改名');
    f.db.prepare("UPDATE sources SET sync_status = 'running' WHERE id = 1").run();
    assert.equal((await f.patch({ name: '不能部分保存', url: originalUrl })).statusCode, 409);
    assert.equal((await f.patch({ name: '同步时改名' })).statusCode, 200);
  } finally { pending.resolve(await preview(replacementUrl)); await edit; await f.close(); }
});

test('saving after validation rechecks duplicate repositories and source removal', async () => {
  for (const action of ['duplicate', 'removed']) {
    const pending = deferred<Awaited<ReturnType<typeof preview>>>();
    let entered = false;
    const f = await fixture(async () => { entered = true; return pending.promise; });
    let edit: ReturnType<typeof f.patch> | undefined;
    try {
      edit = f.patch({ name: '不能部分保存', url: replacementUrl });
      await until(() => entered, 'URL validation started');
      if (action === 'duplicate') f.db.prepare("INSERT INTO sources(name, url, branch) VALUES ('New', ?, 'main')").run(replacementUrl);
      else await f.app.inject({ method: 'DELETE', url: '/api/sources/1', headers: f.headers });
      pending.resolve(await preview(replacementUrl));
      assert.equal((await edit).statusCode, action === 'duplicate' ? 409 : 404);
      assert.equal(source(f.db).name, 'Original');
      assert.equal(source(f.db).url, originalUrl);
    } finally { pending.resolve(await preview(replacementUrl)); await edit; await f.close(); }
  }
});

test('editing a paused or never-published source does not enable sync or pretend a job is running', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE sources SET sync_enabled = 0, published_sha = NULL, published_url = NULL, sync_status = 'failed', last_error = 'old failure' WHERE id = 1").run();
    assert.equal((await f.patch({ name: 'Paused', url: replacementUrl })).statusCode, 200);
    assert.equal(source(f.db).sync_enabled, 0);
    assert.equal(source(f.db).sync_status, 'pending');
    assert.equal(source(f.db).last_error, null);
    assert.equal((await f.sync()).json().code, 'SOURCE_PAUSED');
  } finally { await f.close(); }
});

test('legacy database migration records the published URL once and preserves a pending change across restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'mark-source-migration-'));
  const file = join(root, 'mark.db');
  let db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE sources (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, branch TEXT NOT NULL,
      published_sha TEXT, sync_status TEXT NOT NULL DEFAULT 'queued', last_error TEXT,
      last_sync_at TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.prepare("INSERT INTO sources(name, url, branch, published_sha) VALUES ('Old', ?, 'main', 'old-version')").run(originalUrl);
    db.prepare("INSERT INTO sources(name, url, branch) VALUES ('Empty', ?, 'main')").run(replacementUrl);
    db.close();
    db = openDatabase(file);
    assert.equal(source(db).published_url, originalUrl);
    assert.equal(source(db).sync_enabled, 1);
    assert.equal(db.prepare('SELECT published_url FROM sources WHERE id = 2').get()!.published_url, null);
    db.prepare("UPDATE sources SET url = 'https://github.com/mark-fixture/new.git' WHERE id = 1").run();
    db.close();
    db = openDatabase(file);
    assert.equal(source(db).published_url, originalUrl);
    assert.equal(source(db).url, 'https://github.com/mark-fixture/new.git');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

function git(repo: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepository(path: string, content: string, branch = 'main') {
  execFileSync('git', ['init', '-q', '-b', branch, path]);
  git(path, 'config', 'user.email', 'fixture@example.invalid');
  git(path, 'config', 'user.name', 'Mark Fixture');
  writeFileSync(join(path, 'guide.md'), content);
  git(path, 'add', '.');
  git(path, 'commit', '-qm', 'Fixture');
  return git(path, 'rev-parse', 'HEAD');
}

test('real Git retargeting keeps old content on failure, preserves historical commits and requires annotation review', async () => {
  const f = await fixture(async (url) => ({ ...await preview(url), branch: url === replacementUrl ? 'docs' : 'main' }), false);
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  const config = join(f.root, 'git-fixtures.config');
  let runId: number | undefined;
  const waitRun = async () => {
    await until(() => f.db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(runId!)?.status !== 'running', 'Sync finished');
    return f.db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(runId!)!;
  };
  try {
    const a = join(f.root, 'original');
    const b = join(f.root, 'replacement');
    const originalMarkdown = '# Original Guide\n\nshared quote\n\noriginal-only information\n';
    const replacementMarkdown = '# Replacement Guide\n\nshared quote\n\nreplacement-only information\n';
    const firstSha = makeRepository(a, originalMarkdown);
    const secondSha = makeRepository(b, replacementMarkdown, 'docs');
    for (const [url, local] of [[originalUrl, a], [replacementUrl, b], ['https://github.com/mark-fixture/broken.git', join(f.root, 'missing')]]) {
      execFileSync('git', ['config', '--file', config, `url.file://${local}.insteadOf`, url]);
    }
    process.env.GIT_CONFIG_GLOBAL = config;
    f.db.prepare("INSERT INTO sources(id, name, url, branch) VALUES (1, 'Original', ?, 'main')").run(originalUrl);
    runId = (await f.sync()).json().runId;
    assert.equal((await waitRun()).status, 'success');
    addPersonalData(f.db, firstSha);
    const before = personal(f.db);
    assert.equal((await f.patch({ name: 'Broken', url: 'https://github.com/mark-fixture/broken' })).statusCode, 200);
    assert.equal((await f.get('/api/documents/1')).json().markdown, originalMarkdown);
    runId = (await f.sync()).json().runId;
    assert.equal((await waitRun()).status, 'failed');
    assert.equal(source(f.db).published_sha, firstSha);
    assert.equal(source(f.db).published_url, originalUrl);
    assert.deepEqual(personal(f.db), before);
    assert.equal((await f.get('/api/documents/1')).json().markdown, originalMarkdown);

    assert.equal((await f.patch({ name: 'Replacement', url: replacementUrl })).statusCode, 200);
    assert.equal((await f.get('/api/documents/1')).json().markdown, originalMarkdown);
    runId = (await f.sync()).json().runId;
    assert.equal((await waitRun()).status, 'success');
    assert.equal(source(f.db).published_sha, secondSha);
    assert.equal(source(f.db).published_url, replacementUrl);
    assert.equal(git(mirrorPath(f.root, 1), 'config', '--get', 'remote.origin.url'), replacementUrl);
    assert.equal((await f.get('/api/documents/1')).json().markdown, replacementMarkdown);
    assert.equal((await f.get('/api/sources')).json()[0].pendingUrlChange, 0);
    assert.equal((await f.get('/api/search?q=original-only')).json().results.length, 0);
    assert.equal((await f.get('/api/search?q=replacement-only')).json().results[0].id, 1);
    const after = personal(f.db);
    assert.deepEqual(after.reading, before.reading);
    assert.deepEqual(after.bookmarks, before.bookmarks);
    assert.equal(after.annotations[0].note, '保留的笔记');
    assert.equal(after.annotations[0].created_sha, firstSha);
    assert.equal(after.annotations[0].anchor_status, 'needs_review');
    assert.equal((await readTreeFile(mirrorPath(f.root, 1), firstSha, 'guide.md')).toString(), originalMarkdown);
    const diff = await f.get(`/api/updates/${runId}/diff?documentId=1`);
    assert.equal(diff.statusCode, 200);
    assert.equal(diff.json().before, originalMarkdown);
    assert.equal(diff.json().after, replacementMarkdown);

    // A later change in the new repository must not silently reattach an old repository's quote.
    writeFileSync(join(b, 'guide.md'), replacementMarkdown + '\nNew section\n');
    git(b, 'add', '.'); git(b, 'commit', '-qm', 'Next version');
    runId = (await f.sync()).json().runId;
    assert.equal((await waitRun()).status, 'success');
    assert.equal(personal(f.db).annotations[0].anchor_status, 'needs_review');
  } finally {
    if (runId) await waitRun();
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
    await f.close();
  }
});
