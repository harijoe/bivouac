import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth.js';
import { PERMS } from '../src/githubapp.js';
import { mockGithub } from './ghmock.js';
import { makeEnv } from './helpers.js';

const cookies = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const setCookieOf = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(name + '='));

async function githubLogin(env: ReturnType<typeof makeEnv>, ghCode: string, jar = '', clientId = 'Iv1.test') {
  const start = await env.app.request('/auth/github/start?next=/projects', { headers: jar ? { cookie: jar } : {} });
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(loc.searchParams.get('client_id')).toBe(clientId);
  const state = loc.searchParams.get('state')!;
  const stateJar = [jar, cookies(start)].filter(Boolean).join('; ');
  return env.app.request(`/auth/github/callback?code=${ghCode}&state=${state}`, { headers: { cookie: stateJar } });
}

describe('GitHub login', () => {
  it('signs in an allowed account with a hardened 30-day session cookie', async () => {
    const gh = mockGithub();
    const env = makeEnv({}, { github: gh.impl });
    const r = await githubLogin(env, 'julien');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/projects');
    const sc = setCookieOf(r, '__Host-bv_session')!;
    expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/Secure/); expect(sc).toMatch(/SameSite=Lax/); expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain/i);
    expect(sc).toMatch(/Max-Age=2592000/);
    const me: any = await (await env.app.request('/api/session', { headers: { cookie: cookies(r) } })).json();
    expect(me.user).toMatchObject({ login: 'julien', githubId: 42, role: 'admin' });
  });

  it('refuses accounts that are not on the allow-list (by numeric id), and accepts them once added', async () => {
    const gh = mockGithub();
    const env = makeEnv({}, { github: gh.impl });
    const refused = await githubLogin(env, 'bob');
    expect(refused.headers.get('location')).toBe('/login?error=not_allowed');
    expect(setCookieOf(refused, '__Host-bv_session')).toBeUndefined();
    expect(env.ctx.auth.listAudit().some((a) => a.action === 'login_refused')).toBe(true);
    // allow-list by login resolves to the permanent numeric id
    env.ctx.auth.addAllowed('user', '77', 'bob');
    const ok = await githubLogin(env, 'bob');
    expect(ok.headers.get('location')).toBe('/projects');
    const me: any = await (await env.app.request('/api/session', { headers: { cookie: cookies(ok) } })).json();
    expect(me.user).toMatchObject({ login: 'bob', role: 'user' });
    // removing the entry ends the session immediately
    env.ctx.auth.removeAllowed(env.ctx.auth.listAllowed()[0].id);
    env.ctx.auth.removeUser(77);
    expect(((await (await env.app.request('/api/session', { headers: { cookie: cookies(ok) } })).json()) as any).user).toBeNull();
  });

  it('allows members of an allowed organisation', async () => {
    const gh = mockGithub({ orgMembers: { acme: ['bob'] } });
    const env = makeEnv({}, { github: gh.impl });
    env.ctx.auth.addAllowed('org', 'acme');
    const ok = await githubLogin(env, 'bob');
    expect(ok.headers.get('location')).toBe('/projects');
    expect(gh.calls.some((c) => c.url.includes('/orgs/acme/members/bob'))).toBe(true);
  });

  it('rejects a wrong or missing OAuth state', async () => {
    const env = makeEnv({}, { github: mockGithub().impl });
    const r = await env.app.request('/auth/github/callback?code=julien&state=forged', { headers: { cookie: 'bv_gh_state=' + encodeURIComponent(JSON.stringify({ state: 'real', next: '/' })) } });
    expect(r.headers.get('location')).toBe('/login?error=state');
    expect((await env.app.request('/auth/github/callback?code=julien&state=x')).headers.get('location')).toBe('/login?error=state');
  });

  it('open redirects through ?next are neutralised', async () => {
    const env = makeEnv({}, { github: mockGithub().impl });
    const start = await env.app.request('/auth/github/start?next=//evil.example');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const r = await env.app.request(`/auth/github/callback?code=julien&state=${state}`, { headers: { cookie: cookies(start) } });
    expect(r.headers.get('location')).toBe('/');
  });

  it('every API route needs a session; sessions of removed users stop working', async () => {
    const env = makeEnv();
    for (const [m, u] of [['GET', '/api/projects'], ['GET', '/api/tasks'], ['GET', '/api/settings'], ['GET', '/api/stream'], ['POST', '/api/claude/login'], ['GET', '/api/totals'], ['GET', '/api/github/repos']]) {
      expect((await env.app.request(u, { method: m })).status, u).toBe(401);
    }
    expect((await env.app.request('/api/health')).status).toBe(200);
    expect((await env.call('GET', '/api/projects')).status).toBe(200);
    expect((await env.call('POST', '/api/logout')).status).toBe(200);
    expect((await env.call('GET', '/api/projects')).status).toBe(401);
  });

  it('non-admins cannot change settings', async () => {
    const env = makeEnv();
    env.ctx.auth.upsertUser({ githubId: 5, login: 'eve' }, 'user');
    env.ctx.auth.addAllowed('user', '5');
    const sid = env.ctx.auth.createSession(5);
    const H = { cookie: `${env.cookieName}=${sid}`, 'content-type': 'application/json' };
    expect((await env.call('PUT', '/api/claude/apikey', { key: 'sk-ant-' + 'a'.repeat(30) }, H)).status).toBe(403);
    expect((await env.call('POST', '/api/projects', { fullName: 'a/b' }, H)).status).toBe(403);
    expect((await env.call('POST', '/api/settings/allowlist', { kind: 'org', value: 'x' }, H)).status).toBe(403);
    expect((await env.call('GET', '/api/tasks', undefined, H)).status).toBe(200);
  });

  it('refuses cross-origin writes and sends a strict CSP', async () => {
    const env = makeEnv({}, {});
    env.cfg.testMode = false;
    const evil = await env.app.request('/api/logout', { method: 'POST', headers: { ...env.H, origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const same = await env.app.request('/api/logout', { method: 'POST', headers: { ...env.H, origin: 'https://1-2-3-4.sslip.io' } });
    expect(same.status).toBe(200);
    const csp = (await env.app.request('/api/health')).headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'"); expect(csp).toContain("script-src 'self'"); expect(csp).not.toContain('unsafe-inline'); expect(csp).toContain("frame-ancestors 'none'");
  });

  it('rate-limits login attempts', async () => {
    const env = makeEnv({}, { github: mockGithub().impl });
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await env.app.request('/auth/github/start', { headers: { 'x-forwarded-for': '9.9.9.9' } })).status;
    expect(last).toBe(429);
    expect((await env.app.request('/auth/github/start', { headers: { 'x-forwarded-for': '8.8.8.8' } })).status).toBe(302);
  });
  it('the rate limiter blocks, then forgets', () => {
    let now = 0;
    const l = new RateLimiter(() => now);
    for (let i = 0; i < 3; i++) expect(l.hit('k', 3, 1000)).toBe(0);
    expect(l.hit('k', 3, 1000)).toBeGreaterThan(0);
    now = 500; expect(l.hit('k', 3, 1000)).toBeGreaterThan(0);
    now = 1600; expect(l.hit('k', 3, 1000)).toBe(0);
  });
});

describe('setup link and admin onboarding', () => {
  it('first-run: setup code → GitHub App manifest → admin connected → link closed for good', async () => {
    const gh = mockGithub();
    const env = makeEnv({}, { github: gh.impl, configured: false });
    const code = env.ctx.auth.createSetupCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // wrong code: no access
    expect((await env.app.request('/setup?code=AAAA-AAAA')).headers.getSetCookie().length).toBe(0);
    expect((await env.app.request('/api/setup/state')).status).toBe(401);

    const open = await env.app.request(`/setup?code=${code}`);
    const jar = cookies(open);
    expect(jar).toMatch(/bv_setup=/);
    const state: any = await (await env.app.request('/api/setup/state', { headers: { cookie: jar } })).json();
    expect(state.githubConfigured).toBe(false); expect(state.domain).toBe('1-2-3-4.sslip.io'); expect(state.publicIp).toBe('1.2.3.4');

    // manifest: private app, no webhook, URLs on the instance domain
    const m: any = await (await env.app.request('/api/setup/github/manifest', { method: 'POST', headers: { cookie: jar, 'content-type': 'application/json' }, body: '{}' })).json();
    const manifest = JSON.parse(m.manifest);
    expect(m.action).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    expect(manifest.public).toBe(false);
    expect(manifest.redirect_url).toBe('https://1-2-3-4.sslip.io/api/setup/github/created');
    expect(manifest.callback_urls).toEqual(['https://1-2-3-4.sslip.io/auth/github/callback']);
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.default_permissions).toMatchObject({ contents: 'write', pull_requests: 'write', metadata: 'read' });
    const org: any = await (await env.app.request('/api/setup/github/manifest', { method: 'POST', headers: { cookie: jar, 'content-type': 'application/json' }, body: JSON.stringify({ organization: 'acme' }) })).json();
    expect(org.action).toMatch(/organizations\/acme\/settings\/apps\/new/);

    // GitHub redirects back with a code; a wrong state is refused
    const bad = await env.app.request('/api/setup/github/created?code=GOODCODE&state=forged', { headers: { cookie: jar } });
    expect(bad.headers.get('location')).toBe('/setup?error=github_state');
    const goodState = new URL(org.action).searchParams.get('state')!;
    const back = await env.app.request(`/api/setup/github/created?code=GOODCODE&state=${goodState}`, { headers: { cookie: jar } });
    expect(back.headers.get('location')).toBe('/auth/github/start?next=/setup');
    expect(env.ctx.gh.creds?.slug).toBe('bivouac-abc');
    // secrets (private key, client secret) are encrypted at rest
    const raw = JSON.stringify(env.store.db.prepare('SELECT * FROM settings').all());
    expect(raw).not.toContain('PRIVATE KEY'); expect(raw).not.toContain('"cs"');

    // sign in as the creator: becomes admin, setup closes
    const login = await githubLogin(env, 'julien', jar, 'Iv1.new');
    expect(login.headers.get('location')).toBe('/setup?step=repos');
    expect(env.ctx.auth.getUser(42)?.role).toBe('admin');
    expect(env.ctx.auth.setupOpen()).toBe(false);
    const after = await env.app.request(`/setup?code=${code}`);
    expect(after.headers.getSetCookie().some((c) => c.startsWith('bv_setup=') && !c.includes('Max-Age=0'))).toBe(false);
    expect((await env.app.request('/api/setup/state', { headers: { cookie: jar } })).status).toBe(401);
  });

  it('reset-admin gives a new link that reopens the wizard', async () => {
    const env = makeEnv();
    expect(env.ctx.auth.setupOpen()).toBe(false);
    const code = env.ctx.auth.createSetupCode();
    expect(env.ctx.auth.setupOpen()).toBe(true);
    expect(env.ctx.auth.checkSetupCode(code.toLowerCase())).toBe(true);
    expect(env.ctx.auth.checkSetupCode('ZZZZ-ZZZZ')).toBe(false);
    // the code is stored hashed
    expect(env.store.getSetting('setup_code_hash')).not.toContain(code);
  });

  it('brute-forcing the setup code is rate limited', async () => {
    const env = makeEnv();
    env.ctx.auth.createSetupCode();
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await env.app.request(`/setup?code=AAAA-${String(1000 + i)}`, { headers: { 'x-forwarded-for': '6.6.6.6' } })).status;
    expect(last).toBe(429);
  });

  it('domain step: a root domain is checked on itself and on a random subdomain, with records relative to the zone', async () => {
    const env = makeEnv();
    const code = env.ctx.auth.createSetupCode();
    const jar = cookies(await env.app.request(`/setup?code=${code}`));
    const post = (u: string, b: object) => env.app.request(u, { method: 'POST', headers: { cookie: jar, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const asked: string[] = [];
    env.ctx.resolve4 = async (h) => { asked.push(h); return ['1.2.3.4']; };
    const r1: any = await (await post('/api/setup/domain/check', { domain: 'bivouac.cloud' })).json();
    expect(r1.ok).toBe(true);
    expect(r1.records.map((r: any) => r.name)).toEqual(['@', '*']);
    const r2: any = await (await post('/api/setup/domain/check', { domain: 'bivouac.cloud' })).json();
    expect(asked.filter((h) => h === 'bivouac.cloud')).toHaveLength(2);
    expect(asked.filter((h) => /^bv-[0-9a-f]{8}\.bivouac\.cloud$/.test(h))).toHaveLength(2);
    expect(r1.probe).not.toBe(r2.probe);
    const sub: any = await (await post('/api/setup/domain/check', { domain: 'dev.deslope.com' })).json();
    expect(sub.records.map((r: any) => r.name)).toEqual(['dev', '*.dev']);
    expect(asked).toContain('dev.deslope.com');
    expect(asked.some((h) => /^bv-[0-9a-f]{8}\.dev\.deslope\.com$/.test(h))).toBe(true);
    const uk: any = await (await post('/api/setup/domain/check', { domain: 'mysite.co.uk' })).json();
    expect(uk.records.map((r: any) => r.name)).toEqual(['@', '*']);
  });

  it('domain step: DNS check against the server IP, then the new domain is served', async () => {
    const env = makeEnv();
    const code = env.ctx.auth.createSetupCode();
    const jar = cookies(await env.app.request(`/setup?code=${code}`));
    const post = (u: string, b: object) => env.app.request(u, { method: 'POST', headers: { cookie: jar, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    expect(((await (await post('/api/setup/domain/check', { domain: 'not a domain' })).json()) as any).ok).toBe(false);
    env.ctx.resolve4 = async (h) => (h === 'bv.example.com' ? ['1.2.3.4'] : h.endsWith('.bv.example.com') ? ['9.9.9.9'] : []);
    const half: any = await (await post('/api/setup/domain/check', { domain: 'bv.example.com' })).json();
    expect(half.ok).toBe(false); expect(half.apex).toEqual(['1.2.3.4']); expect(half.wildcard).toEqual(['9.9.9.9']);
    expect((await post('/api/setup/domain/apply', { domain: 'bv.example.com', code })).status).toBe(400);
    env.ctx.resolve4 = async () => ['1.2.3.4'];
    const ok: any = await (await post('/api/setup/domain/apply', { domain: 'bv.example.com', code })).json();
    expect(ok.redirect).toBe(`https://bv.example.com/setup?code=${code}`);
    expect(env.cfg.domain).toBe('bv.example.com');
    expect(env.store.getSetting('domain')).toBe('bv.example.com');
    const conf: any = await (await env.internal.request('/internal/traefik')).json();
    expect(conf.http.routers['bivouac-web'].rule).toBe('Host(`bv.example.com`) || Host(`1-2-3-4.sslip.io`)');
    const meta: any = await (await env.app.request('/.well-known/oauth-protected-resource')).json();
    expect(meta.resource).toBe('https://bv.example.com/mcp');
  });
});

describe('GitHub installation tokens', () => {
  it('are limited to the project repository and the permissions needed', async () => {
    const gh = mockGithub();
    const env = makeEnv({}, { github: gh.impl });
    const p = env.store.createProject({ name: 'demo', repoUrl: 'https://github.com/julien/demo.git', defaultBranch: 'main', githubRepo: 'julien/demo', installationId: 7 });
    const read = await env.svc.repoToken(p, 'read');
    const write = await env.svc.repoToken(p, 'write');
    expect(read).toMatch(/^ghs_/); expect(write).toMatch(/^ghs_/); expect(read).not.toBe(write);
    const reqs = gh.calls.filter((c) => c.url.endsWith('/access_tokens'));
    expect(reqs).toHaveLength(2);
    expect(reqs[0].body).toEqual({ repositories: ['demo'], permissions: PERMS.read });
    expect(reqs[1].body).toEqual({ repositories: ['demo'], permissions: PERMS.write });
    expect(reqs[0].url).toContain('/installations/7/');
    // the request is authenticated as the app (RS256 JWT), never with a user token
    const jwt = reqs[0].auth!.replace('Bearer ', '');
    const [h, b] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
    expect(h).toEqual({ alg: 'RS256', typ: 'JWT' }); expect(b.iss).toBe('Iv1.test'); expect(b.exp - b.iat).toBeLessThanOrEqual(660);
    // cached while valid
    await env.svc.repoToken(p, 'read');
    expect(gh.calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(2);
  });

  it('a fine-grained token on the project wins (advanced option)', async () => {
    const env = makeEnv();
    const p = env.store.createProject({ name: 'demo', repoUrl: 'x', defaultBranch: 'main', githubToken: 'github_pat_abc' });
    expect(await env.svc.repoToken(p, 'write')).toBe('github_pat_abc');
  });

  it('projects are added from the repositories the app can see', async () => {
    const gh = mockGithub({ repos: [{ full_name: 'julien/demo', default_branch: 'trunk', private: true }, { full_name: 'julien/other', default_branch: 'main', private: false }] });
    const env = makeEnv({}, { github: gh.impl });
    const list: any = await (await env.call('GET', '/api/github/repos')).json();
    expect(list.repos.map((r: any) => r.fullName)).toEqual(expect.arrayContaining(['julien/demo', 'julien/other']));
    expect(list.installUrl).toBe('https://github.com/apps/bivouac-test/installations/new');
    const r = await env.call('POST', '/api/projects', { fullName: 'julien/demo' });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: 'demo', defaultBranch: 'trunk', githubRepo: 'julien/demo', installationId: 7, repoUrl: 'https://github.com/julien/demo.git' });
    expect((await env.call('POST', '/api/projects', { fullName: 'julien/demo' })).status).toBe(409);
    const missing = await env.call('POST', '/api/projects', { fullName: 'julien/secret' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error).toMatch(/not available to the GitHub App/);
  });

  it('opens pull requests with a write-scoped token, never a user token', async () => {
    const gh = mockGithub();
    const env = makeEnv({}, { github: gh.impl });
    const p = env.store.createProject({ name: 'demo', repoUrl: 'https://github.com/julien/demo.git', defaultBranch: 'main', githubRepo: 'julien/demo', installationId: 7 });
    const t = env.store.createTask({ projectId: p.id, name: 'x', title: 't', prompt: 'p', successCommand: 'true', baseBranch: 'main', maxIterations: 1, maxCostUsd: 1 }, () => 'agent/x');
    env.store.patchTask(t.id, { pushed: true });
    const url = await env.mgr.openPr(t.id);
    expect(url).toBe('https://github.com/julien/demo/pull/1');
    const pr = gh.calls.find((c) => c.url.endsWith('/pulls'))!;
    expect(pr.auth).toMatch(/^Bearer ghs_/);
    expect(pr.body).toMatchObject({ head: 'agent/x', base: 'main' });
  });
});

describe('GitHub step: organisation lookup and repositories added with a token', () => {
  it('validates an organisation name against the public API (found, not found, rate limited)', async () => {
    const gh = mockGithub();
    const env = makeEnv({}, { github: gh.impl });
    const code = env.ctx.auth.createSetupCode();
    const jar = cookies(await env.app.request(`/setup?code=${code}`));
    const get = async (n: string) => { const r = await env.app.request(`/api/setup/github/org?name=${n}`, { headers: { cookie: jar } }); return { status: r.status, body: (await r.json()) as any }; };
    expect((await get('alpic-ai')).body).toEqual({ found: true, login: 'alpic-ai', name: 'Alpic', avatarUrl: 'https://avatars.githubusercontent.com/u/1' });
    expect((await get('nope')).body).toEqual({ found: false });
    expect((await get('bad%20name')).body).toEqual({ found: false });
    const limited = await get('limited');
    expect(limited.status).toBe(503); expect(limited.body.error).toMatch(/limiting/);
    expect(gh.calls.every((c) => c.auth === null)).toBe(true); // public API, no credentials
    expect((await env.app.request('/api/setup/github/org?name=alpic-ai')).status).toBe(401); // the setup guard still applies
  });

  it('adds a repository with a fine-grained token after checking access and permissions', async () => {
    const gh = mockGithub();
    const env = makeEnv({}, { github: gh.impl });
    const add = async (token: string, repoUrl = 'https://github.com/julien/demo') => env.call('POST', '/api/projects', { repoUrl, githubToken: token });
    const wrong = await add('ghp_classic'); expect(wrong.status).toBe(400); expect(((await wrong.json()) as any).error).toMatch(/rejected this token/);
    const other = await add('github_pat_otherrepo'); expect(((await other.json()) as any).error).toMatch(/cannot access julien\/demo.*Only select repositories/);
    const ro = await add('github_pat_readonly'); expect(((await ro.json()) as any).error).toMatch(/Contents: Read and write/);
    const np = await add('github_pat_nopulls'); expect(((await np.json()) as any).error).toMatch(/Pull requests: Read and write/);
    const ok = await add('github_pat_good');
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ name: 'demo', defaultBranch: 'trunk', githubRepo: 'julien/demo' });
    expect(JSON.stringify(env.store.db.prepare('SELECT * FROM projects').all())).not.toContain('github_pat_good'); // stored encrypted
  });
});
