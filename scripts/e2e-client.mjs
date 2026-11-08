// End-to-end checks against a freshly installed bivouac, run from OUTSIDE the server (this VPS).
//   node scripts/e2e-client.mjs --base https://1-2-3-4.sslip.io --session <cookie value> --repo-url <url> --gh-token <pat> [--insecure] [--real]
// Covers: certificate, closed surfaces, project via token, the official MCP SDK OAuth flow (dynamic registration, PKCE, refresh rotation),
// two tasks with the fake claude (or one with the real CLI), preview access control, share links, live rename, client revocation.
import { createRequire } from 'node:module';
import path from 'node:path';
import { connect as tlsConnect } from 'node:tls';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]] : a), []));
const BASE = String(args.base).replace(/\/$/, ''), HOST = new URL(BASE).host;
const COOKIE_NAME = '__Host-bv_session';
const COOKIE = `${COOKIE_NAME}=${args.session}`;
const REAL = !!args.real;
if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const require = createRequire(path.resolve('packages/daemon/package.json'));
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const { auth } = await import(require.resolve('@modelcontextprotocol/sdk/client/auth.js'));

let step = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); process.exit(1); };
const check = (c, m) => (c ? ok(m) : fail(m));
const title = (m) => console.log(`\n[${++step}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 180000, every = 2000, what = 'condition') {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const r = await fn(); if (r) return r; } catch (e) { last = e; } await sleep(every); }
  fail(`timeout waiting for ${what} (${last ?? ''})`);
}
const raw = (url, o = {}) => fetch(url, { redirect: 'manual', ...o });
const dash = async (method, p, body) => {
  const r = await raw(BASE + p, { method, headers: { cookie: COOKIE, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const previewUrl = (name, project) => `https://${name}.${project}.${HOST}`;
const toolJson = (r) => JSON.parse(r.content[0].text);

title('certificate and closed surfaces');
const health = await waitFor(async () => { const r = await raw(`${BASE}/api/health`); return r.ok ? r.json() : false; }, 120000, 3000, 'HTTPS health');
ok(`dashboard answers over HTTPS (version ${health.version})`);
if (!args.insecure) {
  const cert = await new Promise((res, rej) => { const s = tlsConnect({ host: HOST, port: 443, servername: HOST }, () => { const c = s.getPeerCertificate(); s.end(); res({ c, authorized: s.authorized }); }); s.on('error', rej); });
  check(cert.authorized, `certificate is valid and trusted (issuer: ${cert.c.issuer.O})`);
}
check((await raw(`${BASE.replace('https', 'http')}/api/health`)).status === 308 || (await raw(`${BASE.replace('https', 'http')}/api/health`)).status === 301, 'plain HTTP redirects to HTTPS');
for (const p of ['/api/projects', '/api/tasks', '/api/settings', '/api/stream', '/api/setup/state']) check((await raw(BASE + p)).status === 401, `${p} needs a session`);
check(!(await (await raw(`${BASE}/internal/traefik`)).text()).includes('routers'), '/internal/* is not reachable from outside');
check((await raw(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401, '/mcp needs a token');
const meta = await (await raw(`${BASE}/.well-known/oauth-authorization-server`)).json();
check(meta.code_challenge_methods_supported?.[0] === 'S256' && meta.issuer === BASE, 'OAuth metadata is published');
check((await dash('GET', '/api/session')).json.user?.role === 'admin', 'test session is accepted');

title('project added with a fine-grained token');
const added = await dash('POST', '/api/projects', { repoUrl: args['repo-url'], githubToken: args['gh-token'], name: 'demo', defaultBranch: args['repo-branch'] });
check(added.status === 201 || added.status === 409, `project demo available (${added.status})`);

title('MCP: official SDK, dynamic registration, PKCE, authorization approved with the test session');
let saved = {};
const provider = {
  get redirectUrl() { return 'http://localhost:33418/callback'; },
  get clientMetadata() { return { client_name: 'e2e-sdk-client', redirect_uris: ['http://localhost:33418/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
  clientInformation: () => saved.client, saveClientInformation: (c) => { saved.client = c; },
  tokens: () => saved.tokens, saveTokens: (t) => { saved.tokens = t; },
  saveCodeVerifier: (v) => { saved.verifier = v; }, codeVerifier: () => saved.verifier,
  redirectToAuthorization: async (url) => { saved.authUrl = url; },
};
const mcpUrl = new URL(`${BASE}/mcp`);
let res = await auth(provider, { serverUrl: mcpUrl });
check(res === 'REDIRECT' && saved.authUrl, 'SDK discovered the server, registered itself and built the authorization URL');
const au = saved.authUrl;
check(au.searchParams.get('code_challenge_method') === 'S256', 'authorization request uses PKCE S256');
const consent = await dash('GET', `/api/oauth/authorize-info?${au.searchParams}`);
check(consent.status === 200 && consent.json.client.name === 'e2e-sdk-client', 'consent screen shows the client');
const evil = await raw(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'evil', redirect_uris: ['https://evil.example/cb'] }) });
check(evil.status === 400, 'a redirect URI outside the allow-list is refused at registration');
const approved = await dash('POST', '/api/oauth/authorize', { ...Object.fromEntries(au.searchParams), decision: 'approve' });
const code = new URL(approved.json.redirect).searchParams.get('code');
res = await auth(provider, { serverUrl: mcpUrl, authorizationCode: code });
check(res === 'AUTHORIZED' && saved.tokens?.access_token, 'authorization code exchanged for tokens');
check(saved.tokens.expires_in === 3600 && saved.tokens.refresh_token, 'access token lives one hour, refresh token issued');
const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
const mcp = new Client({ name: 'e2e', version: '1' });
await mcp.connect(transport);
const tools = (await mcp.listTools()).tools;
check(tools.length === 13 && tools.find((t) => t.name === 'list_projects').annotations.readOnlyHint === true, 'all 13 tools listed with annotations');
const call = async (name, a) => mcp.callTool({ name, arguments: a });
check(toolJson(await call('list_projects', {})).some((p) => p.name === 'demo'), 'list_projects sees the project');

if (!REAL) {
  title('Connect Claude from the dashboard (setup-token in a throwaway container, fake CLI replaying the real output)');
  const st0 = (await dash('GET', '/api/claude')).json;
  check(st0.connected === false, 'Claude is not connected yet');
  const noClaude = await call('create_task', { project: 'demo', name: 'nope', prompt: 'x' });
  check(noClaude.isError && /connect Claude in the bivouac dashboard/.test(noClaude.content[0].text), 'create_task explains how to connect Claude');
  const login = (await dash('POST', '/api/claude/login')).json;
  const lst = await waitFor(async () => { const s = (await dash('GET', `/api/claude/login/${login.id}`)).json; return s.phase === 'waiting_code' ? s : false; }, 60000, 1500, 'sign-in URL');
  check(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/.test(lst.url), 'sign-in URL extracted from the terminal output');
  await dash('POST', `/api/claude/login/${login.id}/code`, { code: 'FAKE-CODE' });
  await waitFor(async () => (await dash('GET', `/api/claude/login/${login.id}`)).json.phase === 'done', 60000, 1500, 'token');
  const st1 = (await dash('GET', '/api/claude')).json;
  check(st1.connected && st1.kind === 'oauth' && Date.parse(st1.expiresAt) > Date.now() + 360 * 86400e3, 'token stored, expiry one year away');
}

title(REAL ? 'a real task with the official claude CLI' : 'two parallel tasks with the fake claude');
const specs = REAL
  ? [['alpha', 'Add a button that increments a counter on the home page, with a test.', 'pnpm test && pnpm build']]
  : [['alpha', 'task A', 'pnpm test && pnpm build'], ['beta', 'task B FAKE_SCENARIO=fail-then-succeed', 'grep -q ok fake-output.txt && pnpm test']];
const created = {};
for (const [name, prompt, success] of specs) {
  const r = await call('create_task', { project: 'demo', name, prompt, success_command: success, max_iterations: 4, max_cost_usd: REAL ? 1.5 : 5, idempotency_key: `e2e-${name}` });
  created[name] = toolJson(r);
  check(created[name].previewUrl === previewUrl(name, 'demo') && created[name].started, `create_task ${name} answered immediately with preview ${created[name].previewUrl}`);
}
const dup = await call('create_task', { project: 'demo', name: 'alpha', prompt: 'x' });
check(dup.isError && /already used/.test(dup.content[0].text), 'duplicate name is refused with a helpful message');
const finals = {};
await waitFor(async () => {
  for (const [name] of specs) finals[name] = toolJson(await call('get_task', { project: 'demo', task: name }));
  return specs.every(([n]) => ['succeeded', 'failed', 'budget_exceeded', 'max_iterations'].includes(finals[n].status));
}, REAL ? 900000 : 360000, 4000, 'tasks to finish');
for (const [name] of specs) check(finals[name].status === 'succeeded', `${name} succeeded (iteration ${finals[name].iteration}, $${finals[name].costUsd.toFixed(3)})`);
if (!REAL) check(finals.beta.iteration === 2, 'beta needed a second iteration (failure fed back to the agent)');

title('preview access control');
const A = previewUrl('alpha', 'demo');
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const denied = await waitFor(async () => { const r = await raw(A + '/'); return r.status === 403 ? r : false; }, 180000, 3000, 'preview host (certificate issuance)');
check((await denied.text()).includes('Access denied'), 'preview refused without access, with a clear page');
const link = (await dash('POST', `/api/tasks/${created.alpha.id}/preview-link`)).json.url;
const entry = await raw(link);
check(entry.status === 302 && /^bv_preview=/.test(cookieOf(entry)), 'owner ticket swaps for a preview cookie');
const pc = cookieOf(entry);
const page = await waitFor(async () => { const r = await raw(A + '/', { headers: { cookie: pc } }); return r.status === 200 ? r.text() : false; }, 120000, 3000, 'preview content');
check(page.includes('bivouac example') || REAL, 'preview content served to the owner');
check((await raw(link)).status === 403, 'the ticket is single use');
check((await raw(A + '/', { headers: { cookie: COOKIE } })).status === 403, 'the dashboard session does not open previews');
if (!REAL) {
  const B = previewUrl('beta', 'demo');
  const share = toolJson(await call('create_share_link', { project: 'demo', task: 'beta', duration: '1h' }));
  const se = await raw(share.url);
  check(se.status === 302, 'share link accepted');
  const sc = cookieOf(se);
  await waitFor(async () => (await raw(B + '/', { headers: { cookie: sc } })).status === 200, 120000, 3000, 'shared preview');
  check((await raw(A + '/', { headers: { cookie: sc } })).status === 403, 'the share link opens that preview only');
  await call('revoke_share_link', { project: 'demo', task: 'beta', link_id: share.id });
  check((await raw(B + '/', { headers: { cookie: sc } })).status === 403, 'revoked share link stops working');
}

title('live rename');
const t0 = Date.now();
check((await dash('POST', `/api/tasks/${created.alpha.id}/rename`, { name: 'renamed' })).status === 200, 'rename accepted');
const l2 = (await dash('POST', `/api/tasks/${created.alpha.id}/preview-link`)).json.url;
await waitFor(async () => { const r = await raw(l2); return r.status === 302 ? r : false; }, 120000, 1000, 'renamed host');
ok(`new address answers ${((Date.now() - t0) / 1000).toFixed(1)} s after the rename`);
await waitFor(async () => (await raw(A + '/')).status === 404, 60000, 1000, 'old host to disappear');
ok('old address is gone');

title('refresh rotation, revocation');
const rt1 = saved.tokens.refresh_token;
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
const rot = await raw(`${BASE}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: rt1, client_id: saved.client.client_id }));
const t2 = await rot.json();
check(rot.status === 200 && t2.refresh_token !== rt1, 'refresh token rotates');
check((await raw(`${BASE}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: rt1, client_id: saved.client.client_id }))).status === 400, 'reusing a rotated refresh token is refused');
check((await raw(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t2.access_token}` }, body: '{}' })).status === 401, '…and it revoked the whole grant');
// new grant, revoke it from the dashboard
saved = { client: saved.client };
res = await auth(provider, { serverUrl: mcpUrl });
const ap2 = await dash('POST', '/api/oauth/authorize', { ...Object.fromEntries(saved.authUrl.searchParams), decision: 'approve' });
res = await auth(provider, { serverUrl: mcpUrl, authorizationCode: new URL(ap2.json.redirect).searchParams.get('code') });
const at = saved.tokens.access_token;
const mcpOk = (t) => raw(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
check((await mcpOk(at)).status === 200, 'new client authorized');
const grants = (await dash('GET', '/api/settings')).json.grants;
check(grants.some((g) => g.clientName === 'e2e-sdk-client'), 'dashboard lists the connected client');
await dash('DELETE', `/api/settings/grants/${grants[0].id}`);
check((await mcpOk(at)).status === 401, 'token refused after the client was revoked');

title('stop and clean up');
await call('stop_task', { project: 'demo', task: 'renamed' }).catch(() => {});
for (const id of Object.values(created).map((c) => c.id)) check((await dash('DELETE', `/api/tasks/${id}?force=1`)).status === 200, `task ${id} deleted`);
await mcp.close().catch(() => {});
console.log('\nE2E CLIENT CHECKS PASSED');
