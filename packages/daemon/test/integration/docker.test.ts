// Real Docker, the real daemon image running as two services (web + executor), real Traefik (HTTP provider + forwardAuth) and the fake claude.
// Mirrors the production topology: `web` has no Docker socket, `executor` is reachable only from `web`.
// Everything is prefixed `bivouac-dev-`.  Run: pnpm test:integration   (builds the images unless BIVOUAC_TEST_DAEMON_IMAGE / BIVOUAC_TEST_IMAGE are set)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Dockerode from 'dockerode';
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const docker = new Dockerode();
const P = 'bivouac-dev-it';
const PFX = 'bivouac-dev';
const HTTP_PORT = Number(process.env.BIVOUAC_TEST_PORT ?? 8088);
const TASK_IMAGE = process.env.BIVOUAC_TEST_IMAGE ?? 'bivouac-dev-task:test';
const DAEMON_IMAGE = process.env.BIVOUAC_TEST_DAEMON_IMAGE ?? 'bivouac-dev-daemon:test';
const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const DOMAIN = '127-0-0-1.sslip.io';
const NET = { edge: `${P}-edge`, ctl: `${P}-ctl`, egress: `${P}-egress` };
const C = { traefik: `${P}-traefik`, web: `${P}-web`, executor: `${P}-executor` };

async function waitFor<T>(fn: () => Promise<T | false>, ms = 120000, every = 1000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try { const r = await fn(); if (r) return r; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timeout waiting (last error: ${String(last)})`);
}
interface Res { status: number; text: string; headers: Record<string, string | string[] | undefined> }
/** HTTP through Traefik with an explicit Host (fetch() ignores a custom Host header, so use node:http). */
const get = (host: string, p: string, o: { cookie?: string; method?: string; body?: string; headers?: Record<string, string> } = {}) =>
  new Promise<Res>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: HTTP_PORT, path: p, method: o.method ?? 'GET', headers: { host, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(o.body) } : {}), ...o.headers } }, (res) => {
      let text = '';
      res.on('data', (b) => (text += b));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
const cookieOf = (r: Res) => String((r.headers['set-cookie'] as string[] | undefined)?.[0] ?? '').split(';')[0];
const hostOf = (name: string, project: string) => `${name}.${project}.${DOMAIN}`;
const pathOf = (u: string) => { const x = new URL(u); return x.pathname + x.search; };
const sh = (cmd: string[]) => execFileSync('docker', cmd, { encoding: 'utf8' }).trim();

let dataDir: string, reposDir: string;
let sessionCookie = '';
const dash = async (method: string, p: string, body?: unknown) => {
  const r = await get(DOMAIN, p, { method, cookie: sessionCookie, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (() => { try { return JSON.parse(r.text); } catch { return r.text; } })() as any };
};

async function removeAll() {
  for (const c of Object.values(C)) await docker.getContainer(c).remove({ force: true }).catch(() => {});
  for (const c of await docker.listContainers({ all: true, filters: { name: ['bivouac-dev-task-'] } })) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
  for (const n of Object.values(NET)) await docker.getNetwork(n).remove().catch(() => {});
  for (const n of await docker.listNetworks({ filters: { name: ['bivouac-dev-task-'] } })) await docker.getNetwork(n.Id).remove().catch(() => {});
}

async function mkContainer(name: string, image: string, o: { cmd?: string[]; env?: Record<string, string>; user?: string; binds?: string[]; nets: string[]; ports?: Record<string, string>; alias?: string }) {
  const c = await docker.createContainer({
    name, Image: image, Cmd: o.cmd, User: o.user, Labels: { 'bivouac.dev': 'true' },
    Env: Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`),
    ExposedPorts: o.ports ? Object.fromEntries(Object.keys(o.ports).map((p) => [p, {}])) : undefined,
    HostConfig: { Binds: o.binds, PortBindings: o.ports ? Object.fromEntries(Object.entries(o.ports).map(([k, v]) => [k, [{ HostIp: '127.0.0.1', HostPort: v }]])) : undefined, NetworkMode: o.nets[0] },
    NetworkingConfig: { EndpointsConfig: { [o.nets[0]]: { Aliases: [name] } } },
  });
  for (const n of o.nets.slice(1)) await docker.getNetwork(n).connect({ Container: name, EndpointConfig: { Aliases: [name] } });
  await c.start();
  return c;
}

beforeAll(async () => {
  if (!process.env.BIVOUAC_TEST_IMAGE) execSync(`docker build -q -t ${TASK_IMAGE} ${path.join(repoRoot, 'packages/task-image')}`, { stdio: 'inherit' });
  if (!process.env.BIVOUAC_TEST_DAEMON_IMAGE) execSync(`docker build -q -t ${DAEMON_IMAGE} -f ${path.join(repoRoot, 'packages/daemon/Dockerfile')} ${repoRoot}`, { stdio: 'inherit' });
  execSync('docker image inspect traefik:v3.6 >/dev/null 2>&1 || docker pull -q traefik:v3.6', { stdio: 'inherit' });
  await removeAll();

  // example projects as local git repos (bind-mounted read-only where the services read them)
  reposDir = mkdtempSync(path.join(tmpdir(), 'bv-it-repos-'));
  chmodSync(reposDir, 0o755);
  const mkRepo = (name: string, setup: (dir: string) => void) => {
    const dir = path.join(reposDir, name);
    mkdirSync(dir);
    setup(dir);
    execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init', { cwd: dir });
    execSync(`chmod -R a+rX ${dir}`);
  };
  mkRepo('demo', (d) => cpSync(path.join(repoRoot, 'examples/vite-app'), d, { recursive: true }));
  mkRepo('echo', (d) => {
    writeFileSync(path.join(d, 'echo.mjs'), "import http from 'node:http'; http.createServer((q, r) => r.end(JSON.stringify({ cookie: q.headers.cookie ?? null, host: q.headers.host }))).listen(3000, '0.0.0.0');\n");
    writeFileSync(path.join(d, 'bivouac.yml'), 'dev:\n  command: node echo.mjs\n  port: 3000\nsuccess: "true"\n');
  });

  dataDir = mkdtempSync(path.join(tmpdir(), 'bv-it-data-'));
  chmodSync(dataDir, 0o777);
  mkdirSync(path.join(dataDir, 'web'), { mode: 0o777 });
  chmodSync(path.join(dataDir, 'web'), 0o777);

  await docker.createNetwork({ Name: NET.edge, Labels: { 'bivouac.dev': 'true' } });
  await docker.createNetwork({ Name: NET.ctl, Internal: true, Labels: { 'bivouac.dev': 'true' } });
  await docker.createNetwork({ Name: NET.egress, Labels: { 'bivouac.dev': 'true' } });

  const secret = randomBytes(16).toString('hex');
  const common = { BIVOUAC_NAME_PREFIX: PFX, BIVOUAC_TASK_IMAGE: TASK_IMAGE, BIVOUAC_CLAUDE_BIN: '/opt/bivouac/fake-claude', BIVOUAC_DOMAIN: DOMAIN, BIVOUAC_PREVIEW_SCHEME: 'http', BIVOUAC_PREVIEW_PORT: String(HTTP_PORT), BIVOUAC_TRAEFIK_CONTAINER: C.traefik, BIVOUAC_EXECUTOR_TOKEN: secret };
  await mkContainer(C.executor, DAEMON_IMAGE, {
    cmd: ['node', 'packages/daemon/dist/executor-main.js'], nets: [NET.ctl, NET.egress], user: 'root',
    binds: ['/var/run/docker.sock:/var/run/docker.sock', `${dataDir}:${dataDir}`, `${reposDir}:${reposDir}:ro`],
    env: { ...common, BIVOUAC_DATA_DIR: dataDir, BIVOUAC_PORT: '3002' },
  });
  await mkContainer(C.web, DAEMON_IMAGE, {
    nets: [NET.edge, NET.ctl, NET.egress], user: '1000:1000', binds: [`${path.join(dataDir, 'web')}:/data`, `${reposDir}:${reposDir}:ro`],
    env: { ...common, BIVOUAC_DATA_DIR: '/data', BIVOUAC_WEB_HOST: C.web, BIVOUAC_EXECUTOR_URL: `http://${C.executor}:3002`, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake', BIVOUAC_TEST_MODE: '1', BIVOUAC_PUBLIC_IP: '127.0.0.1' },
  });
  await mkContainer(C.traefik, 'traefik:v3.6', {
    nets: [NET.edge], ports: { '80/tcp': String(HTTP_PORT) },
    cmd: [`--providers.http.endpoint=http://${C.web}:3001/internal/traefik`, '--providers.http.pollInterval=1s', '--entrypoints.web.address=:80', '--log.level=INFO'],
  });
  await waitFor(async () => (await get(DOMAIN, '/api/health')).status === 200, 90000, 1000);
  sessionCookie = `bv_session=${sh(['exec', C.web, 'node', 'packages/daemon/dist/cli.js', 'session', 'create', '--github-id', '1001'])}`;
}, 600000);

afterAll(async () => {
  for (const c of [C.web, C.executor, C.traefik]) {
    const logs = await docker.getContainer(c).logs({ stdout: true, stderr: true, tail: 25 }).catch(() => '');
    console.log(`--- ${c}\n${logs.toString()}`);
  }
  await removeAll();
}, 120000);

/** MCP over Traefik, authorised through the real OAuth flow (PKCE) with the test session. */
async function mcpClient() {
  const redirect = 'http://localhost:33418/callback';
  const reg = (await get(DOMAIN, '/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'it-client', redirect_uris: [redirect] }) }));
  const client = JSON.parse(reg.text);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const approved = await dash('POST', '/api/oauth/authorize', { client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's', decision: 'approve' });
  const code = new URL(approved.json.redirect).searchParams.get('code')!;
  const tok = JSON.parse((await get(DOMAIN, '/oauth/token', { method: 'POST', body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier }) })).text);
  const nodeFetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const r = await get(u.host, u.pathname + u.search, { method: init.method, body: init.body, headers: { ...headers, accept: headers.accept ?? 'application/json' } });
    return new Response(r.text, { status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([, v]) => typeof v === 'string') as [string, string][]) });
  }) as typeof fetch;
  const transport = new StreamableHTTPClientTransport(new URL(`http://${DOMAIN}/mcp`), { fetch: nodeFetch, requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } });
  const c = new Client({ name: 'it', version: '1' });
  await c.connect(transport);
  return { c, tok, client };
}
const json = (r: any) => JSON.parse(r.content[0].text);

describe('docker integration (real topology)', () => {
  it('web has no Docker socket, executor is unreachable from the edge network', async () => {
    const web = await docker.getContainer(C.web).inspect();
    expect(web.HostConfig.Binds!.join(' ')).not.toContain('docker.sock');
    expect(web.Config.User).toBe('1000:1000');
    expect(() => sh(['exec', C.web, 'test', '-e', '/var/run/docker.sock'])).toThrow();
    // Traefik (edge only) cannot even resolve the executor
    expect(() => sh(['exec', C.traefik, 'getent', 'hosts', C.executor])).toThrow();
    const tr = await docker.getContainer(C.traefik).inspect();
    expect(Object.keys(tr.NetworkSettings.Networks)).toEqual([NET.edge]);
    // the executor refuses unauthenticated calls
    expect(sh(['exec', C.web, 'node', '-e', `fetch('http://${C.executor}:3002/sandboxes/1/running?project=x').then(r=>console.log(r.status))`])).toBe('401');
    // /internal/* is not reachable through the public router
    expect([404, 401]).toContain((await get(DOMAIN, '/internal/traefik')).status);
  });

  it('MCP end to end: two parallel tasks, dynamic routes behind forwardAuth, share links, live rename, cleanup', async () => {
    const added = await dash('POST', '/api/projects', { repoUrl: path.join(reposDir, 'demo'), name: 'demo' });
    expect(added.status).toBe(201);
    const { c, tok, client } = await mcpClient();

    const a = json(await c.callTool({ name: 'create_task', arguments: { project: 'demo', name: 'alpha', prompt: 'task A', success_command: 'pnpm test && pnpm build', max_iterations: 4 } }));
    const b = json(await c.callTool({ name: 'create_task', arguments: { project: 'demo', name: 'beta', prompt: 'task B FAKE_SCENARIO=fail-then-succeed', success_command: 'grep -q ok fake-output.txt && pnpm test', max_iterations: 4 } }));
    expect(a.previewUrl).toBe(`http://alpha.demo.${DOMAIN}:${HTTP_PORT}`);

    // containers + networks exist, prefixed, non-root, no docker socket, no Traefik labels
    await waitFor(async () => (await docker.listContainers({ filters: { name: [`${PFX}-task-`] } })).length === 2);
    const info = await docker.getContainer(`bivouac-dev-task-${a.id}`).inspect();
    expect(info.Config.User).toBe('node');
    expect(info.HostConfig.Binds!.join(' ')).not.toContain('docker.sock');
    expect(Object.keys(info.Config.Labels).filter((l) => l.startsWith('traefik.'))).toHaveLength(0);
    expect(info.HostConfig.NanoCpus).toBe(2e9);

    // previews are refused without access: a clear page, not a 404
    const hostA = hostOf('alpha', 'demo'), hostB = hostOf('beta', 'demo');
    const denied = await waitFor(async () => { const x = await get(hostA, '/'); return x.status === 403 ? x : false; }, 60000, 500);
    expect(denied.text).toContain('Access denied');

    // the owner opens the preview from the dashboard: single-use ticket → cookie → app
    const ownerLink = (await dash('POST', `/api/tasks/${a.id}/preview-link`)).json.url as string;
    const entry = await get(hostA, pathOf(ownerLink));
    expect(entry.status).toBe(302);
    expect(entry.headers.location).toBe('/');
    const cookieA = cookieOf(entry);
    expect(cookieA).toMatch(/^bv_preview=/);
    const page = await waitFor(async () => { const x = await get(hostA, '/', { cookie: cookieA }); return x.status === 200 && x.text.includes('<div id="root">') ? x : false; }, 240000, 2000);
    expect(page.text).toContain('bivouac example');
    expect((await get(hostA, pathOf(ownerLink))).status).toBe(403); // ticket already used
    expect((await get(hostB, '/', { cookie: cookieA })).status).toBe(403); // a cookie is bound to its host
    expect((await get(hostA, '/', { cookie: sessionCookie })).status).toBe(403); // the dashboard session is no key to previews

    // share link: gives access to beta only, until revoked
    const share = json(await c.callTool({ name: 'create_share_link', arguments: { project: 'demo', task: 'beta', duration: '1h' } }));
    const shared = await get(hostB, pathOf(share.url));
    expect(shared.status).toBe(302);
    const cookieB = cookieOf(shared);
    await waitFor(async () => (await get(hostB, '/', { cookie: cookieB })).status === 200, 240000, 2000);
    expect((await get(hostA, '/', { cookie: cookieB })).status).toBe(403);
    await c.callTool({ name: 'revoke_share_link', arguments: { project: 'demo', task: 'beta', link_id: share.id } });
    expect((await get(hostB, '/', { cookie: cookieB })).status).toBe(403);

    // MCP polling until both are done
    const final: Record<string, any> = {};
    await waitFor(async () => {
      for (const n of ['alpha', 'beta']) final[n] = json(await c.callTool({ name: 'get_task', arguments: { project: 'demo', task: n } }));
      return ['succeeded', 'failed', 'budget_exceeded', 'max_iterations'].includes(final.alpha.status) && ['succeeded', 'failed', 'budget_exceeded', 'max_iterations'].includes(final.beta.status);
    }, 240000, 2000);
    expect(final.alpha).toMatchObject({ status: 'succeeded', iteration: 1 });
    expect(final.beta).toMatchObject({ status: 'succeeded', iteration: 2 });

    // live rename: the new host answers within seconds, the container was not restarted, the old host is gone
    const startedAt = (await docker.getContainer(`bivouac-dev-task-${a.id}`).inspect()).State.StartedAt;
    expect((await dash('POST', `/api/tasks/${a.id}/rename`, { name: 'gamma' })).status).toBe(200);
    const hostG = hostOf('gamma', 'demo');
    const t0 = Date.now();
    const link2 = (await dash('POST', `/api/tasks/${a.id}/preview-link`)).json.url as string;
    const gEntry = await waitFor(async () => { const x = await get(hostG, pathOf(link2)); return x.status === 302 ? x : false; }, 15000, 250);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect((await get(hostG, '/', { cookie: cookieOf(gEntry) })).status).toBe(200);
    await waitFor(async () => (await get(hostA, '/')).status === 404, 15000, 250);
    expect((await docker.getContainer(`bivouac-dev-task-${a.id}`).inspect()).State.StartedAt).toBe(startedAt);
    expect((await dash('GET', `/api/tasks/${a.id}`)).json.branch).toBe(a.branch);
    expect((await dash('POST', `/api/projects/demo/tasks/beta`)).status).toBe(404); // creation is not a dashboard feature

    // dev server logs are readable through the executor
    expect((await dash('GET', `/api/tasks/${a.id}/devlogs`)).json.text).toContain('ready in');

    // stopping and revoking the OAuth client
    expect(json(await c.callTool({ name: 'stop_task', arguments: { project: 'demo', task: 'beta' } })).status).toBeTruthy();
    const settings = (await dash('GET', '/api/settings')).json;
    expect(settings.grants.map((g: any) => g.clientName)).toContain('it-client');
    await dash('DELETE', `/api/settings/grants/${settings.grants[0].id}`);
    const after = await get(DOMAIN, '/mcp', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${tok.access_token}` } });
    expect(after.status).toBe(401);
    void client;
    await c.close().catch(() => {});

    // cleanup
    for (const id of [a.id, b.id]) expect((await dash('DELETE', `/api/tasks/${id}?force=1`)).status).toBe(200);
    expect(await docker.listContainers({ all: true, filters: { name: ['bivouac-dev-task-'] } })).toHaveLength(0);
    expect(await docker.listNetworks({ filters: { name: ['bivouac-dev-task-'] } })).toHaveLength(0);
  });

  it('the preview cookie never reaches the app, other cookies do', async () => {
    expect((await dash('POST', '/api/projects', { repoUrl: path.join(reposDir, 'echo'), name: 'echo' })).status).toBe(201);
    const { c } = await mcpClient();
    const t = json(await c.callTool({ name: 'create_task', arguments: { project: 'echo', name: 'headers', prompt: 'x' } }));
    const host = hostOf('headers', 'echo');
    await waitFor(async () => (await get(host, '/')).status === 403, 120000, 500);
    const link = (await dash('POST', `/api/tasks/${t.id}/preview-link`)).json.url as string;
    const cookie = cookieOf(await get(host, pathOf(link)));
    const r = await waitFor(async () => { const x = await get(host, '/', { cookie: `${cookie}; theme=dark; bivouac_session=SECRET` }); return x.status === 200 ? x : false; }, 120000, 1000);
    const seen = JSON.parse(r.text);
    expect(seen.cookie).not.toContain('bv_preview');
    expect(seen.cookie).toContain('theme=dark');
    const solo = JSON.parse((await get(host, '/', { cookie })).text);
    expect(solo.cookie ?? '').not.toContain('bv_preview');
    await dash('DELETE', `/api/tasks/${t.id}?force=1`);
    await c.close().catch(() => {});
  });
});
