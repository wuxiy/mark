// Run on the Work-OS host. Secrets are read/written there and never printed.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

process.umask(0o077);
function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required');
  return value;
}
const runtime = resolve(requiredEnv('WORK_OS_RUNTIME_DIR'));
const origin = new URL(requiredEnv('MARK_PUBLIC_ORIGIN'));
const apiOrigin = new URL(requiredEnv('AUTHENTIK_API_URL'));
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
  throw new Error('MARK_PUBLIC_ORIGIN must be a plain HTTPS origin');
if (!['http:', 'https:'].includes(apiOrigin.protocol) || apiOrigin.pathname !== '/' || apiOrigin.search || apiOrigin.hash || apiOrigin.username || apiOrigin.password ||
    (apiOrigin.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(apiOrigin.hostname)))
  throw new Error('AUTHENTIK_API_URL must be HTTPS or a loopback HTTP origin');
const file = resolve(runtime, 'clients.json');
const config = JSON.parse(readFileSync(file, 'utf8'));
const prior = JSON.stringify(Object.fromEntries(Object.entries(config.clients).filter(([key]) => key !== 'mark')));
const token = readFileSync(resolve(runtime, 'bootstrap-token'), 'utf8').trim();
async function api(path, method = 'GET', body) {
  const response = await fetch(new URL('/api/v3/' + path, apiOrigin), {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!response.ok) throw new Error('IdP operation failed (' + response.status + '); response suppressed');
  return response.status === 204 ? null : response.json();
}
const save = () => { writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); chmodSync(file, 0o600); };
const backup = resolve(runtime, 'clients-before-mark.json');
if (!existsSync(backup)) { copyFileSync(file, backup); chmodSync(backup, 0o600); }
const owner = await api('core/users/' + config.ownerPK + '/');
if (!owner.is_active || owner.uuid !== config.ownerSubject) throw new Error('Existing Owner identity mismatch');
const flows = (await api('flows/instances/')).results;
const flow = slug => {
  const found = flows.find(item => item.slug === slug);
  if (!found) throw new Error('Missing identity flow');
  return found.pk;
};
const providers = (await api('providers/oauth2/')).results;
const signingKey = providers.find(item => item.client_id === config.clients.homepage.clientID)?.signing_key;
if (!signingKey) throw new Error('Missing existing signing key');
const scopes = (await api('propertymappings/provider/scope/')).results.filter(item => item.scope_name === 'openid').map(item => item.pk);
const clientID = 'workos-mark';
const callback = origin.origin + '/api/auth/oidc/callback';
const issuer = new URL('/application/o/mark/', config.clients.homepage.issuer).href;
if (new URL(issuer).protocol !== 'https:') throw new Error('Existing identity issuer must use HTTPS');
let client = config.clients.mark;
if (!client) {
  if (providers.some(item => item.client_id === clientID)) throw new Error('Untracked Mark provider exists; reconcile before retrying');
  client = config.clients.mark = { clientID, clientSecret: randomBytes(32).toString('hex'),
    issuer, redirectURL: callback };
  save();
}
if (client.clientID !== clientID || client.redirectURL !== callback || client.issuer !== issuer) throw new Error('Mark client configuration mismatch');
if (!client.providerPK) {
  const provider = await api('providers/oauth2/', 'POST', {
    name: 'Mark', client_id: clientID, client_secret: client.clientSecret, client_type: 'confidential',
    grant_types: ['authorization_code'], sub_mode: 'user_uuid', issuer_mode: 'per_provider',
    authentication_flow: flow('default-authentication-flow'), authorization_flow: flow('default-provider-authorization-implicit-consent'),
    invalidation_flow: flow('default-provider-invalidation-flow'), signing_key: signingKey,
    property_mappings: scopes, include_claims_in_id_token: true, access_code_validity: 'minutes=1', access_token_validity: 'minutes=5',
    redirect_uris: [{ matching_mode: 'strict', url: callback }],
  });
  client.providerPK = provider.pk; save();
}
const provider = await api('providers/oauth2/' + client.providerPK + '/');
if (provider.client_id !== clientID || provider.sub_mode !== 'user_uuid' || provider.issuer_mode !== 'per_provider' ||
    provider.client_secret !== client.clientSecret || provider.client_type !== 'confidential' ||
    provider.redirect_uris.length !== 1 || provider.redirect_uris[0].url !== callback || provider.redirect_uris[0].matching_mode !== 'strict')
  throw new Error('Recorded Mark provider mismatch; refusing to rotate or broaden access');
if (!client.applicationPK) {
  const app = await api('core/applications/', 'POST', { name: 'Mark', slug: 'mark', provider: client.providerPK,
    meta_launch_url: origin.origin, policy_engine_mode: 'all' });
  client.applicationPK = app.pk; save();
}
const application = await api('core/applications/mark/');
if (application.pk !== client.applicationPK || application.provider !== client.providerPK) throw new Error('Mark application mismatch');
const bindings = (await api('policies/bindings/?target=' + client.applicationPK)).results;
if (bindings.some(item => item.user !== config.ownerPK || !item.enabled || item.failure_result || item.group || item.policy))
  throw new Error('Unexpected Mark binding; refusing to broaden access');
if (!bindings.length) await api('policies/bindings/', 'POST', { target: client.applicationPK, user: config.ownerPK, order: 0, enabled: true, failure_result: false });
if ((await api('policies/bindings/?target=' + client.applicationPK)).results.length !== 1) throw new Error('Mark must have exactly one Owner binding');
if (prior !== JSON.stringify(Object.fromEntries(Object.entries(config.clients).filter(([key]) => key !== 'mark')))) throw new Error('Existing clients changed');
console.log(JSON.stringify({ application: 'Mark', fixedOwnerBinding: true, independentClient: true, existingClientsPreserved: true }));
