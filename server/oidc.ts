import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import * as client from 'openid-client';
import { Agent, fetch as transportFetch } from 'undici';

export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  ownerSubject: string;
  caFile?: string;
  resolveAddress?: string;
}

export class OidcFailure extends Error {
  constructor(public code: 'OIDC_DENIED' | 'OIDC_UNAVAILABLE') {
    super(code); // Never include provider responses, codes, tokens or secrets.
  }
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  return url;
}

export function validateOidc(options: OidcOptions): void {
  try {
    httpsUrl(options.issuer);
    if (httpsUrl(options.callbackUrl).pathname !== '/api/auth/oidc/callback') throw new Error();
    if (![options.clientId, options.clientSecret, options.ownerSubject].every(value => value?.trim())) throw new Error();
    if (options.resolveAddress && (!isIP(options.resolveAddress) || !options.caFile)) throw new Error();
  } catch {
    throw new Error('OIDC 配置无效：需要 HTTPS issuer、固定回调地址、独立客户端和 Owner subject');
  }
}

export function oidcFromEnv(env: NodeJS.ProcessEnv): OidcOptions | undefined {
  const names = ['ISSUER', 'CLIENT_ID', 'CLIENT_SECRET_FILE', 'CALLBACK_URL', 'OWNER_SUBJECT', 'CA_FILE', 'RESOLVE_ADDRESS'];
  if (!names.some(name => env[`MARK_OIDC_${name}`])) return undefined;
  if (!names.slice(0, 5).every(name => env[`MARK_OIDC_${name}`]?.trim())) {
    throw new Error('OIDC 配置不完整：请填写 .env.example 中的五项必填配置');
  }
  let clientSecret: string;
  try { clientSecret = readFileSync(env.MARK_OIDC_CLIENT_SECRET_FILE!, 'utf8').trim(); }
  catch { throw new Error('无法读取 OIDC 客户端密钥文件'); }
  const options: OidcOptions = {
    issuer: env.MARK_OIDC_ISSUER!, clientId: env.MARK_OIDC_CLIENT_ID!, clientSecret,
    callbackUrl: env.MARK_OIDC_CALLBACK_URL!, ownerSubject: env.MARK_OIDC_OWNER_SUBJECT!,
    caFile: env.MARK_OIDC_CA_FILE || undefined, resolveAddress: env.MARK_OIDC_RESOLVE_ADDRESS || undefined,
  };
  validateOidc(options);
  return options;
}

type Transaction = { state: string; nonce: string; verifier: string; expiresAt: number; config: client.Configuration };
export type OidcFetch = client.CustomFetch;

export class OidcLogin {
  private transactions = new Map<string, Transaction>();
  private cached?: { config: client.Configuration; expiresAt: number };
  private discovering?: Promise<client.Configuration>;
  private agent: Agent;
  private fetcher: OidcFetch;

  constructor(private options: OidcOptions, testFetch?: OidcFetch) {
    validateOidc(options);
    const issuer = new URL(options.issuer);
    this.agent = new Agent({ connect: {
      ...(options.caFile ? { ca: readFileSync(options.caFile, 'utf8') } : {}),
      ...(options.resolveAddress ? { lookup: (hostname, lookupOptions, callback) => {
        if (hostname !== issuer.hostname) return callback(new Error('Unexpected OIDC host'), []);
        const address = options.resolveAddress!;
        const entry = { address, family: isIP(address) };
        if (lookupOptions.all) callback(null, [entry]);
        else callback(null, entry.address, entry.family);
      } } : {}),
    } });
    this.fetcher = async (url, init) => {
      if (new URL(url).origin !== issuer.origin) throw new OidcFailure('OIDC_UNAVAILABLE');
      try {
        const response = testFetch ? await testFetch(url, { ...init, redirect: 'manual' }) :
          await transportFetch(url, { ...init, redirect: 'manual', dispatcher: this.agent }) as unknown as Response;
        if (!response.ok) throw new OidcFailure('OIDC_UNAVAILABLE');
        return response;
      } catch { throw new OidcFailure('OIDC_UNAVAILABLE'); }
    };
  }

  private async configuration(): Promise<client.Configuration> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.config;
    if (!this.discovering) {
      this.discovering = client.discovery(new URL(this.options.issuer), this.options.clientId,
        { client_secret: this.options.clientSecret, id_token_signed_response_alg: 'RS256' },
        client.ClientSecretBasic(this.options.clientSecret),
        { [client.customFetch]: this.fetcher, timeout: 8, execute: [client.enableNonRepudiationChecks] })
        .then(config => {
          const metadata = config.serverMetadata();
          for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
            if (!value || httpsUrl(value).origin !== new URL(this.options.issuer).origin) throw new Error();
          }
          this.cached = { config, expiresAt: Date.now() + 10 * 60_000 };
          return config;
        }).catch(() => { throw new OidcFailure('OIDC_UNAVAILABLE'); })
        .finally(() => { this.discovering = undefined; });
    }
    return this.discovering;
  }

  async start(previousBinding?: string): Promise<{ binding: string; url: string }> {
    for (const [key, value] of this.transactions) if (value.expiresAt <= Date.now()) this.transactions.delete(key);
    if (previousBinding) this.transactions.delete(previousBinding);
    if (this.transactions.size >= 256) throw new OidcFailure('OIDC_UNAVAILABLE');
    const config = await this.configuration();
    const binding = randomBytes(32).toString('hex');
    const verifier = client.randomPKCECodeVerifier();
    const tx = { state: client.randomState(), nonce: client.randomNonce(), verifier, expiresAt: Date.now() + 300_000, config };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.options.callbackUrl, scope: 'openid', response_type: 'code', response_mode: 'query',
      state: tx.state, nonce: tx.nonce, code_challenge_method: 'S256',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
    });
    // Recheck after asynchronous discovery; bound the map during simultaneous starts too.
    if (this.transactions.size >= 256) throw new OidcFailure('OIDC_UNAVAILABLE');
    this.transactions.set(binding, tx);
    return { binding, url: url.href };
  }

  async finish(query: string, binding?: string): Promise<void> {
    const tx = binding ? this.transactions.get(binding) : undefined;
    if (binding) this.transactions.delete(binding); // Consume before any await; a callback is usable once.
    if (!tx || tx.expiresAt <= Date.now()) throw new OidcFailure('OIDC_DENIED');
    const callback = new URL(this.options.callbackUrl);
    callback.search = query;
    try {
      const tokens = await client.authorizationCodeGrant(tx.config, callback, {
        expectedState: tx.state, expectedNonce: tx.nonce, pkceCodeVerifier: tx.verifier, idTokenExpected: true,
      });
      if (tokens.claims()?.sub !== this.options.ownerSubject) throw new OidcFailure('OIDC_DENIED');
      // Tokens remain in this request only. Mark issues its existing local Owner session.
    } catch (cause) {
      // openid-client wraps transport errors. Preserve only our sanitized availability code.
      let nested: unknown = cause;
      for (let depth = 0; depth < 5 && nested instanceof Error; depth++) {
        if (nested instanceof OidcFailure) throw nested;
        nested = nested.cause;
      }
      throw new OidcFailure('OIDC_DENIED');
    }
  }

  async close(): Promise<void> { this.transactions.clear(); await this.agent.close(); }
}
