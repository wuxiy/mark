import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../server/app.ts';
import { resolveModelConfig } from '../server/model-settings.ts';
import type { ModelConfig } from '../server/model-client.ts';

const input = { enabled: true, baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', revision: 0 };
const completion = (text = 'OK') => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

async function fixture(model: ModelConfig = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mark-model-settings-'));
  const passwordFile = join(root, 'password');
  writeFileSync(passwordFile, 'model-settings-fixture-password');
  const { app, db } = await buildApp({ dataDir: root, initialPasswordFile: passwordFile, model });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'model-settings-fixture-password' } });
  const headers = { cookie: login.headers['set-cookie'] as string, 'x-csrf-token': login.json().csrf as string };
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await app.close(); } };
  return { app, db, root, headers, stop,
    get: () => app.inject({ method: 'GET', url: '/api/settings/model', headers }),
    save: (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/settings/model', headers, payload }),
    check: (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/settings/model/test', headers, payload }),
    close: async () => { await stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

function seedDocument(f: Awaited<ReturnType<typeof fixture>>) {
  f.db.prepare("INSERT INTO sources(id, name, url, branch, published_sha, published_url) VALUES (1, 'Fixture', 'https://github.com/test/docs.git', 'main', 'published-version', 'https://github.com/test/docs.git')").run();
  f.db.prepare("INSERT INTO documents(id, source_id, path, title, current_sha, content_hash) VALUES (1, 1, 'guide.md', 'Learning Guide', 'published-version', 'content-hash')").run();
  f.db.prepare("INSERT INTO document_search(title, body, document_id, source_id) VALUES ('Learning Guide', 'Learning facts. PRIVATE_DOCUMENT_SENTINEL', 1, 1)").run();
}

test('model settings require login and CSRF; environment fallback exposes only a key-presence flag', async () => {
  const secret = 'fixture-secret-not-returned';
  const f = await fixture({ baseUrl: input.baseUrl, model: 'environment-model', apiKey: secret });
  try {
    assert.equal((await f.app.inject('/api/settings/model')).statusCode, 401);
    for (const [method, url] of [['PATCH', '/api/settings/model'], ['POST', '/api/settings/model/test']] as const) {
      assert.equal((await f.app.inject({ method, url, headers: { cookie: f.headers.cookie }, payload: input })).statusCode, 403);
    }
    const result = await f.get();
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { enabled: true, baseUrl: input.baseUrl, model: 'environment-model', apiKeyConfigured: true, revision: 0, source: 'environment' });
    assert.equal(result.body.includes(secret), false);
    assert.equal('apiKey' in result.json(), false);
    assert.equal((await f.app.inject({ url: '/api/ask/status', headers: f.headers })).json().configured, true);
  } finally { await f.close(); }
});

test('saving UI configuration hot-applies to Ask and disabling it never falls back to deployment configuration', async () => {
  let calls = 0;
  const f = await fixture({ baseUrl: 'https://old.example.invalid/v1', model: 'old-model', fetcher: async (url, options) => {
    calls++;
    assert.equal(String(url), input.baseUrl + '/chat/completions');
    assert.equal(JSON.parse(options!.body as string).model, input.model);
    assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer fixture-new-secret');
    return completion('Learning facts are in the guide.[1]');
  } });
  try {
    seedDocument(f);
    const response = await f.save({ ...input, apiKey: 'fixture-new-secret' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes('fixture-new-secret'), false);
    const ask = () => f.app.inject({ method: 'POST', url: '/api/ask', headers: f.headers, payload: { question: 'Learning facts', documentId: 1 } });
    const answer = await ask();
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.json().citations[0].publishedSha, 'published-version');
    assert.equal(calls, 1);
    assert.equal((await f.save({ ...input, enabled: false, revision: 1 })).statusCode, 200);
    assert.equal((await ask()).json().code, 'MODEL_NOT_CONFIGURED');
    assert.equal(calls, 1);
    const status = (await f.app.inject({ url: '/api/ask/status', headers: f.headers })).json();
    assert.equal(status.configured, false);
    assert.equal(status.enabled, false);
    assert.equal((await f.get()).json().apiKeyConfigured, true);
    assert.equal((await f.app.inject({ url: '/api/search?q=Learning', headers: f.headers })).json().results.length, 1);
  } finally { await f.close(); }
});

test('connection test uses the draft and retained key, sends no source content and never saves settings', async () => {
  let calls = 0;
  const f = await fixture({ baseUrl: input.baseUrl, model: 'old-model', apiKey: 'fixture-retained-secret', fetcher: async (_, options) => {
    calls++;
    const payload = JSON.parse(options!.body as string);
    assert.equal(payload.model, input.model);
    assert.deepEqual(payload.messages, [{ role: 'user', content: 'Connection test. Reply only OK.' }]);
    assert.equal(JSON.stringify(payload).includes('PRIVATE_DOCUMENT_SENTINEL'), false);
    assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer fixture-retained-secret');
    return completion();
  } });
  try {
    seedDocument(f);
    const result = await f.check({ ...input, enabled: false });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().ok, true);
    assert.equal(result.json().model, input.model);
    assert.ok(result.json().latencyMs >= 0);
    assert.equal(calls, 1);
    assert.equal((await f.get()).json().model, 'old-model');
    assert.equal((await f.get()).json().revision, 0);
    assert.equal(f.db.prepare("SELECT value FROM settings WHERE key = 'model_config'").get(), undefined);
  } finally { await f.close(); }
});

test('invalid inputs and URLs do not partially save or call the model', async () => {
  let calls = 0;
  const f = await fixture({ fetcher: async () => { calls++; return completion(); } });
  try {
    const invalid = [
      {}, { ...input, enabled: 'yes' }, { ...input, revision: -1 }, { ...input, unknown: true },
      { ...input, apiKey: 'fixture-key', clearApiKey: true }, { ...input, model: '' },
      ...['', 'not-a-url', 'ftp://localhost/models', 'https://user:secret@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'https://example.invalid/v1#secret', 'https://example.invalid/v1/chat/completions'].map(baseUrl => ({ ...input, baseUrl })),
    ];
    for (const candidate of invalid) {
      assert.equal((await f.save(candidate)).statusCode, 400);
      assert.equal((await f.check(candidate)).statusCode, 400);
      assert.equal((await f.get()).json().revision, 0);
    }
    assert.equal(calls, 0);
    assert.equal((await f.save({ enabled: false, baseUrl: '', model: '', revision: 0 })).statusCode, 200);
  } finally { await f.close(); }
});

test('blank key keeps the existing key, replacement and clearing work, and address changes require explicit key handling', async () => {
  const fallback = { baseUrl: input.baseUrl, model: input.model, apiKey: 'fixture-original-secret' };
  const f = await fixture(fallback);
  try {
    assert.equal((await f.save({ ...input, baseUrl: 'https://MODEL.example.invalid/v1/' })).statusCode, 200);
    assert.equal(resolveModelConfig(f.db, fallback).apiKey, 'fixture-original-secret');
    const newAddress = { ...input, baseUrl: 'https://other.example.invalid/custom/v1', model: 'replacement-model', revision: 1 };
    assert.equal((await f.save(newAddress)).json().code, 'MODEL_KEY_REQUIRED');
    assert.equal((await f.check(newAddress)).json().code, 'MODEL_KEY_REQUIRED');
    assert.equal((await f.get()).json().model, input.model);
    assert.equal((await f.save({ ...newAddress, apiKey: 'fixture-replacement-secret' })).statusCode, 200);
    assert.equal(resolveModelConfig(f.db, fallback).apiKey, 'fixture-replacement-secret');
    assert.equal((await f.get()).body.includes('fixture-replacement-secret'), false);
    assert.equal((await f.save({ ...newAddress, revision: 2, clearApiKey: true })).statusCode, 200);
    assert.equal(resolveModelConfig(f.db, fallback).apiKey, '');
    assert.equal((await f.get()).json().apiKeyConfigured, false);
  } finally { await f.close(); }
});

test('stale configuration revisions reject saving and testing without overwriting the current settings', async () => {
  let calls = 0;
  const f = await fixture({ fetcher: async () => { calls++; return completion(); } });
  try {
    assert.equal((await f.save(input)).statusCode, 200);
    const before = (await f.get()).body;
    for (const action of [f.save, f.check]) {
      const result = await action({ ...input, model: 'stale-model' });
      assert.equal(result.statusCode, 409);
      assert.equal(result.json().code, 'MODEL_SETTINGS_CHANGED');
    }
    assert.equal((await f.get()).body, before);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('saved settings and disabled state survive restart and override new environment values', async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    assert.equal((await f.save({ ...input, enabled: false, apiKey: 'fixture-persisted-secret' })).statusCode, 200);
    await f.stop();
    reopened = await buildApp({ dataDir: f.root, model: { baseUrl: 'https://new-environment.example.invalid/v1', model: 'environment-model', apiKey: 'fixture-env-secret' } });
    const response = await reopened.app.inject({ url: '/api/settings/model', headers: f.headers });
    assert.equal(response.json().source, 'saved');
    assert.equal(response.json().enabled, false);
    assert.equal(response.json().model, input.model);
    assert.equal(response.json().apiKeyConfigured, true);
    assert.equal(response.body.includes('fixture-persisted-secret'), false);
    assert.equal(resolveModelConfig(reopened.db).apiKey, 'fixture-persisted-secret');
    assert.equal((await reopened.app.inject({ url: '/api/ask/status', headers: f.headers })).json().configured, false);
  } finally { await reopened?.app.close(); await f.close(); }
});

test('provider authentication, model, quota, server and response failures are controlled and never expose provider bodies', async () => {
  let response: Response;
  const f = await fixture({ fetcher: async () => response });
  const cases: Array<[Response, number, string]> = [
    [new Response('fixture-provider-secret', { status: 401 }), 400, 'MODEL_AUTH_FAILED'],
    [new Response('fixture-provider-secret', { status: 403 }), 400, 'MODEL_AUTH_FAILED'],
    [new Response('fixture-provider-secret', { status: 404 }), 400, 'MODEL_NOT_FOUND'],
    [new Response('fixture-provider-secret', { status: 429 }), 429, 'MODEL_RATE_LIMITED'],
    [new Response('fixture-provider-secret', { status: 400 }), 400, 'MODEL_REQUEST_INVALID'],
    [new Response('fixture-provider-secret', { status: 500 }), 503, 'MODEL_UNAVAILABLE'],
    [new Response('not JSON', { status: 200 }), 502, 'MODEL_RESPONSE_INVALID'],
    [completion(''), 503, 'MODEL_EMPTY'],
    [new Response(JSON.stringify({ output: 'OK' }), { status: 200 }), 503, 'MODEL_EMPTY'],
  ];
  try {
    for (const [reply, status, code] of cases) {
      response = reply;
      const result = await f.check(input);
      assert.equal(result.statusCode, status);
      assert.equal(result.json().code, code);
      assert.equal(result.body.includes('fixture-provider-secret'), false);
      assert.equal(result.json().retryable, status >= 500 || status === 429);
      assert.equal((await f.get()).json().revision, 0);
    }
  } finally { await f.close(); }
});

test('connection timeout and network errors remain retryable without changing configuration', async () => {
  let hang = true;
  const keepAlive = setTimeout(() => undefined, 1000);
  const f = await fixture({ timeoutMs: 20, fetcher: async (_, options) => {
    if (!hang) throw new Error('fixture-private-network-error');
    return new Promise<Response>((_, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
  } });
  try {
    assert.equal((await f.check(input)).json().code, 'MODEL_TIMEOUT');
    hang = false;
    const unavailable = await f.check(input);
    assert.equal(unavailable.json().code, 'MODEL_UNAVAILABLE');
    assert.equal(unavailable.body.includes('fixture-private-network-error'), false);
    assert.equal((await f.get()).json().revision, 0);
  } finally { clearTimeout(keepAlive); await f.close(); }
});

test('keyless local-compatible services retain the full base path and omit authorization', async () => {
  const f = await fixture({ fetcher: async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/custom/v1/chat/completions');
    assert.equal('Authorization' in (options!.headers as Record<string, string>), false);
    return completion();
  } });
  try {
    const local = { ...input, baseUrl: 'http://127.0.0.1:11434/custom/v1/' };
    assert.equal((await f.check(local)).statusCode, 200);
    assert.equal((await f.save(local)).json().baseUrl, local.baseUrl.replace(/\/$/, ''));
  } finally { await f.close(); }
});
