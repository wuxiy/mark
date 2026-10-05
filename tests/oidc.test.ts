import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../server/app.ts';
import { oidcFromEnv, validateOidc, type OidcOptions, type OidcFetch } from '../server/oidc.ts';

const issuer = 'https://identity.example.test/application/o/mark/';
const options: OidcOptions = { issuer, clientId: 'mark-test', clientSecret: 'test-only-secret',
  callbackUrl: 'https://mark.example.test/api/auth/oidc/callback', ownerSubject: 'fixed-owner-uuid' };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const unrelatedKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

function fixture() {
  let authorization: URL;
  let claims: Record<string, unknown> = {};
  let wrongSignature = false;
  let unavailable = false;
  let discoveryOverride: Record<string, unknown> = {};
  let tokenRequests = 0;
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const fetcher: OidcFetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, new URL(issuer).origin);
    assert.equal(init?.redirect, 'manual');
    if (unavailable) throw new Error('test unavailable');
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return json({
      issuer, authorization_endpoint: new URL('/authorize', issuer).href,
      token_endpoint: new URL('/token', issuer).href, jwks_uri: new URL('/jwks', issuer).href,
      response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
      ...discoveryOverride,
    });
    if (url.pathname === '/jwks') return json({ keys: [publicJwk] });
    assert.equal(url.pathname, '/token');
    tokenRequests++;
    const credentials = new Headers(init?.headers).get('authorization')!.slice('Basic '.length);
    assert.deepEqual(Buffer.from(credentials, 'base64').toString().split(':').map(decodeURIComponent), [options.clientId, options.clientSecret]);
    const body = new URLSearchParams(init?.body as string);
    assert.equal(body.get('redirect_uri'), options.callbackUrl);
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), authorization.searchParams.get('code_challenge'));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }) + '.' + encode({
      iss: issuer, aud: options.clientId, sub: options.ownerSubject,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
      nonce: authorization.searchParams.get('nonce'), ...claims,
    });
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), wrongSignature ? unrelatedKeys.privateKey : keys.privateKey).toString('base64url');
    return json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 300, id_token: unsigned + '.' + signature });
  };
  return { fetcher, authorize: (url: string) => { authorization = new URL(url); },
    claims: (value: Record<string, unknown>) => { claims = value; },
    wrongSignature: () => { wrongSignature = true; }, unavailable: () => { unavailable = true; },
    discoveryOverride: (value: Record<string, unknown>) => { discoveryOverride = value; },
    tokenRequests: () => tokenRequests };
}

async function instance() {
  const root = mkdtempSync(join(tmpdir(), 'mark-oidc-'));
  const passwordFile = join(root, 'password');
  writeFileSync(passwordFile, 'mark-fallback-test-password');
  const idp = fixture();
  const { app, db } = await buildApp({ dataDir: root, initialPasswordFile: passwordFile, secureCookie: true, oidc: options, oidcFetch: idp.fetcher });
  return { app, db, idp, close: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); },
    start: async () => {
      const response = await app.inject('/api/auth/oidc/start');
      assert.equal(response.statusCode, 302);
      idp.authorize(response.headers.location!);
      const authorize = new URL(response.headers.location!);
      assert.equal(authorize.searchParams.get('scope'), 'openid');
      assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorize.searchParams.get('redirect_uri'), options.callbackUrl);
      assert.equal(authorize.searchParams.get('response_mode'), 'query');
      const binding = String(response.headers['set-cookie']);
      assert.match(binding, /HttpOnly; Secure; Path=\/; SameSite=Lax; Max-Age=300/);
      assert.doesNotMatch(binding, /Domain=/);
      return { cookie: binding.split(';')[0], callback: '/api/auth/oidc/callback?code=test-code&state=' + authorize.searchParams.get('state') };
    } };
}

test('OIDC is optional, rejects partial/unsafe configuration, and never publishes secrets', async () => {
  assert.equal(oidcFromEnv({}), undefined);
  assert.throws(() => oidcFromEnv({ MARK_OIDC_ISSUER: issuer }), /配置不完整/);
  for (const override of [{ issuer: 'http://identity.test' }, { ownerSubject: '' },
    { callbackUrl: 'https://mark.test/other' }, { resolveAddress: '127.0.0.1' }]) {
    assert.throws(() => validateOidc({ ...options, ...override }), /配置无效/);
  }
  const f = await instance();
  try {
    assert.deepEqual((await f.app.inject('/api/auth/oidc/config')).json(), { enabled: true });
    const status = (await f.app.inject('/api/session')).json();
    assert.equal(status.oidcEnabled, true); assert.equal(status.passwordConfigured, true);
    assert(!JSON.stringify(status).includes(options.clientSecret));
    assert.equal((await f.app.inject('/api/sources')).statusCode, 401);
    assert.equal((await f.app.inject('/api/auth/oidc/other')).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/oidc/start' })).statusCode, 401);
  } finally { await f.close(); }
});

test('signed Owner callback issues the existing Mark session, enforces CSRF, and local logout invalidates it', async () => {
  const f = await instance();
  try {
    const marker = f.db.prepare("INSERT INTO settings(key,value) VALUES ('oidc-test-preserved','existing-data')"); marker.run();
    const tx = await f.start();
    const callback = await f.app.inject({ url: tx.callback, headers: { cookie: tx.cookie } });
    assert.equal(callback.statusCode, 302); assert.equal(callback.headers.location, '/library');
    const cookies = callback.headers['set-cookie'] as string[];
    assert(cookies.some(cookie => cookie.startsWith('__Host-mark-oidc=;') && cookie.includes('Max-Age=0')));
    const sessionCookie = cookies.find(cookie => cookie.startsWith('mark_session='))!;
    assert.match(sessionCookie, /HttpOnly.*SameSite=Strict.*Secure/); assert.doesNotMatch(sessionCookie, /Domain=/);
    const cookie = sessionCookie.split(';')[0];
    const status = (await f.app.inject({ url: '/api/session', headers: { cookie } })).json();
    assert.equal(status.authenticated, true); assert(status.csrf);
    assert.equal((await f.app.inject({ url: '/api/sources', headers: { cookie } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie, 'x-csrf-token': status.csrf } })).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/api/sources', headers: { cookie } })).statusCode, 401);
    assert.equal((f.db.prepare("SELECT value FROM settings WHERE key='oidc-test-preserved'").get() as { value: string }).value, 'existing-data');
    assert.equal((await f.app.inject({ url: tx.callback, headers: { cookie: tx.cookie } })).statusCode, 403);
  } finally { await f.close(); }
});

test('callbacks reject wrong Owner, issuer, audience, nonce, expiry, signature, and missing ID token claims', async (t) => {
  for (const [name, claims] of Object.entries({ subject: { sub: 'someone-else' }, issuer: { iss: 'https://other.test/' },
    audience: { aud: 'other-client' }, nonce: { nonce: 'wrong-nonce' }, expiry: { exp: 1 }, missingSubject: { sub: null } })) {
    await t.test(name, async () => {
      const f = await instance();
      try {
        f.idp.claims(claims);
        const tx = await f.start();
        const response = await f.app.inject({ url: tx.callback, headers: { cookie: tx.cookie } });
        assert.equal(response.statusCode, 403);
        assert(!String(response.headers['set-cookie']).includes('mark_session='));
        assert.equal((f.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 0);
      } finally { await f.close(); }
    });
  }
  await t.test('signature', async () => {
    const f = await instance();
    try {
      f.idp.wrongSignature(); const tx = await f.start();
      assert.equal((await f.app.inject({ url: tx.callback, headers: { cookie: tx.cookie } })).statusCode, 403);
    } finally { await f.close(); }
  });
});

test('state and browser binding are mandatory; transactions are one-use and expire', async (t) => {
  for (const mode of ['state', 'missing-binding', 'other-browser', 'replay', 'expired']) await t.test(mode, async (ctx) => {
    const f = await instance();
    try {
      const tx = await f.start();
      if (mode === 'expired') { const now = Date.now(); ctx.mock.method(Date, 'now', () => now + 301_000); }
      let url = tx.callback;
      let cookie = tx.cookie;
      if (mode === 'state') url = url.replace(/state=.*/, 'state=wrong-state');
      if (mode === 'missing-binding') cookie = '';
      if (mode === 'other-browser') cookie = '__Host-mark-oidc=' + '0'.repeat(64);
      if (mode === 'replay') assert.equal((await f.app.inject({ url, headers: { cookie } })).statusCode, 302);
      const before = f.idp.tokenRequests();
      const rejected = await f.app.inject({ url, headers: { cookie } });
      assert.equal(rejected.statusCode, 403);
      assert.equal(f.idp.tokenRequests(), before);
      assert(!String(rejected.headers['set-cookie']).includes('mark_session='));
      if (mode === 'state') assert.equal((await f.app.inject({ url: tx.callback, headers: { cookie } })).statusCode, 403);
    } finally { ctx.mock.restoreAll(); await f.close(); }
  });
});

test('IdP failures preserve password fallback; discovery rejects issuer mismatch and off-origin endpoints', async (t) => {
  for (const mode of ['offline-start', 'offline-callback', 'issuer-mismatch', 'foreign-token-endpoint']) await t.test(mode, async () => {
    const f = await instance();
    try {
      if (mode === 'offline-callback') {
        const tx = await f.start(); f.idp.unavailable();
        assert.equal((await f.app.inject({ url: tx.callback, headers: { cookie: tx.cookie } })).statusCode, 503);
      } else {
        if (mode === 'offline-start') f.idp.unavailable();
        if (mode === 'issuer-mismatch') f.idp.discoveryOverride({ issuer: 'https://other.test/' });
        if (mode === 'foreign-token-endpoint') f.idp.discoveryOverride({ token_endpoint: 'https://other.test/token' });
        assert.equal((await f.app.inject('/api/auth/oidc/start')).statusCode, 503);
      }
      const login = await f.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'mark-fallback-test-password' } });
      assert.equal(login.statusCode, 200);
      assert.equal((await f.app.inject({ url: '/api/sources', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] } })).statusCode, 200);
    } finally { await f.close(); }
  });
});
