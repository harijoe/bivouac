// Dev helper: runs the real web service + dashboard on PORT (default 3100) with *local* sandboxes, the fake claude
// and a mocked GitHub, seeded with a few tasks and a signed-in admin. Used for screenshots and to try the UI without Docker.
//   node dev/demo-server.mjs   → prints the session cookie to use (also served at /__demo/cookie)
import { execSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { buildContext } from '../dist/context-build.js';
import { Store } from '../dist/db.js';
import { LocalSandbox } from '../dist/sandbox.js';
import { createApp, createInternalApp } from '../dist/server.js';

const root = path.resolve(import.meta.dirname, '../../..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'bv-demo-'));
const key = randomBytes(32);
const port = Number(process.env.PORT ?? 3100);
const cfg = {
  dataDir, port, internalPort: port + 1, bind: '127.0.0.1', namePrefix: 'bivouac-dev', taskImage: 'x', claudeBin: path.join(root, 'packages/task-image/fake-claude/claude'),
  domain: 'demo.example.com', previewScheme: 'http', previewPort: port, traefikContainer: 'x', webHost: 'x', certResolver: null, maxParallel: 4, taskUid: 1000,
  dashboardDir: path.join(root, 'packages/dashboard/dist'), secretKey: key, executorUrl: null, executorToken: 'x', oauthToken: 'sk-ant-oat01-demo', apiKey: null,
  oauthRedirectAllow: ['https://claude.ai/*'], testMode: true,
  version: '0.4.0', releasesUrl: 'http://127.0.0.1:1/none', daemonImage: '', hostOptDir: '/opt/bivouac',
};
const store = new Store(path.join(dataDir, 'demo.db'), key);
const sandboxes = new Map();
const mockGithub = async (url) => {
  const u = String(url);
  const j = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  if (u.includes('/access_tokens')) return j({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() });
  if (u.includes('/app/installations')) return j([{ id: 1, account: { login: 'julien', type: 'User' } }]);
  if (u.includes('/installation/repositories')) return j({ repositories: [{ full_name: 'julien/mon-app', default_branch: 'main', private: true, pushed_at: '2026-11-09T10:00:00Z', owner: { login: 'julien' } }, { full_name: 'julien/api-gateway', default_branch: 'main', private: true, pushed_at: '2026-11-01T10:00:00Z', owner: { login: 'julien' } }, { full_name: 'julien/blog', default_branch: 'main', private: false }] });
  if (u.includes('/pulls?state=open')) return j([{ number: 12, html_url: 'https://github.com/julien/mon-app/pull/12', title: 'Add a dark mode toggle', head: { ref: 'agent/t-1-dark-mode' } }]);
  return j({});
};
const ctx = buildContext({
  cfg, store, fetchImpl: mockGithub, publicIp: '203.0.113.7', resolve4: async () => [],
  makeSandbox: (t) => {
    if (!sandboxes.has(t.id)) sandboxes.set(t.id, new LocalSandbox(path.join(dataDir, 'projects', t.projectName, 'tasks', `t-${t.id}`, 'workspace')));
    return sandboxes.get(t.id);
  },
});
const pem = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
ctx.gh.save({ id: 1, slug: 'bivouac-demo', name: 'bivouac-demo', clientId: 'Iv1.demo', clientSecret: 's', pem, webhookSecret: 'w', htmlUrl: 'https://github.com/apps/bivouac-demo', ownerLogin: 'julien' });
ctx.auth.upsertUser({ githubId: 1, login: 'julien', name: 'Julien' }, 'admin');
ctx.auth.upsertUser({ githubId: 2, login: 'camille' }, 'user'); ctx.auth.addAllowed('user', '2', 'camille'); ctx.auth.addAllowed('org', 'acme', 'acme');
const perso = store.createClaudeAccount({ name: 'Perso', kind: 'oauth', secret: 'sk-ant-oat01-demo' });
store.db.prepare('UPDATE claude_accounts SET connected_at=? WHERE id=?').run(new Date(Date.now() - 20 * 86400e3).toISOString(), perso);
const pro = store.createClaudeAccount({ name: 'Alpic pro', kind: 'oauth', secret: 'sk-ant-oat01-demo-pro' });
store.db.prepare('UPDATE claude_accounts SET connected_at=? WHERE id=?').run(new Date(Date.now() - 350 * 86400e3).toISOString(), pro);
store.createClaudeAccount({ name: 'CI key', kind: 'apikey', secret: 'sk-ant-api03-demo-demo-demo-demo-demo' });
const sid = ctx.auth.createSession(1, 'test');

const remote = mkdtempSync(path.join(tmpdir(), 'bv-demo-remote-'));
writeFileSync(path.join(remote, 'README.md'), 'demo\n');
writeFileSync(path.join(remote, 'bivouac.yml'), 'ports:\n  web: 5173\n  api: 3000\nservices:\n  postgres:\n    image: postgres:16\n    env: { POSTGRES_PASSWORD: dev }\n');
execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init', { cwd: remote });
const dev = { dev: { command: 'echo "VITE ready in 312 ms"; sleep 1000', port: 5173 } };
store.setSetting('update_latest', JSON.stringify({ version: '0.3.0', name: 'v0.3.0', url: 'https://github.com/harijoe/bivouac/releases/tag/v0.3.0', publishedAt: new Date(Date.now() - 3600e3).toISOString(), notes: '## 0.3.0\n\n### Added\n- **Update from the dashboard** in one click, with backup and automatic rollback.\n- Several ports per project and `postgres` / `redis` services next to each task.\n- A `get_project_context` tool to plan the next mission from your chat.\n\n### Changed\n- Tasks can no longer reach the host machine.' }));
store.setSetting('update_checked_at', new Date().toISOString());
store.createProject({ name: 'mon-app', repoUrl: remote, defaultBranch: 'main', config: dev, githubRepo: 'julien/mon-app', installationId: 1 });
store.createProject({ name: 'api-gateway', repoUrl: remote, defaultBranch: 'main', config: dev, githubRepo: 'julien/api-gateway', installationId: 1 });
const p = store.getProjectByName('mon-app');
const actor = { kind: 'mcp', label: 'mcp:Claude:julien' };
const seed = [
  ['dark-mode', 'Add a dark mode toggle to the settings page, with a test FAKE_SCENARIO=fail-then-succeed FAKE_COST=0.42 FAKE_DELAY=1500'],
  ['checkout-fix', 'Fix the flaky checkout test FAKE_SCENARIO=succeed FAKE_COST=0.18'],
  ['vite-6', 'Migrate the build to Vite 6 FAKE_SCENARIO=always-fail FAKE_COST=2.2'],
];
for (const [name, prompt] of seed) {
  await ctx.svc.createTask({ project: p.name, name, prompt, successCommand: 'grep -q ok fake-output.txt', maxCostUsd: name === 'vite-6' ? 4 : 5 }, actor).catch((e) => console.error(e.message));
}
// a blocked task and a stuck one, and a dev log with colours for the log viewer
for (const [name, status, error] of [['node-26', 'blocked', 'This repository requires Node >= 26 and I cannot install it without root.\nI need: a runtime entry in bivouac.yml, or a different base version.'], ['flaky-e2e', 'stuck', 'The success command failed twice in a row with the same output and no change to the code.\nError: timeout of 5000ms exceeded']]) {
  const t = await ctx.svc.createTask({ project: p.name, name, prompt: `Demo ${name}`, successCommand: 'true', maxCostUsd: 3 }, actor).then((r) => r.task).catch(() => null);
  if (t) { await ctx.mgr.stop(t.id).catch(() => {}); store.setStatus(t.id, status, error); }
}
const first = store.getTaskByName(p.id, 'dark-mode');
if (first) {
  const ws = sandboxes.get(first.id)?.ws;
  if (ws) {
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(path.join(ws, '.bivouac'), { recursive: true });
    const L = ['\x1b[36mVITE\x1b[0m v6.0.1  ready in \x1b[1m312\x1b[0m ms', '  \x1b[32m➜\x1b[0m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[0m/', '\x1b[33mwarn\x1b[0m  deprecated option "foo"', '\x1b[31mError:\x1b[0m connect ECONNREFUSED postgres:5432', ...Array.from({ length: 400 }, (_, i) => `request GET /api/items?page=${i} 200 ${10 + (i % 40)}ms`)];
    wf(path.join(ws, '.bivouac/dev.log'), L.map((l, i) => `10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(i * 7 % 1000).padStart(3, '0')} ${l}`).join('\n') + '\n');
  }
}
ctx.svc.auth.audit('julien', 'login');
const setupCode = ctx.auth.createSetupCode();
const client = ctx.oauth.registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
const inner = createApp(ctx);
const app = new Hono();
app.get('/__demo/setup-link', (c) => c.text(`/setup?code=${setupCode}`));
app.get('/__demo/authorize-url', (c) => c.text(`/oauth/authorize?${new URLSearchParams({ client_id: client.clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'x' })}`));
app.get('/__demo/cookie', (c) => c.text(`bv_session=${sid}`));
app.route('/', inner);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`demo on http://127.0.0.1:${port}  cookie: bv_session=${sid}`));
serve({ fetch: createInternalApp(ctx).fetch, port: port + 1, hostname: '127.0.0.1' });
