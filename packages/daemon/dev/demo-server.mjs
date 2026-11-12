// Dev helper: runs the real web service + dashboard on PORT (default 3100) with *local* sandboxes, the fake claude
// and a mocked GitHub, seeded with a few tasks and a signed-in admin. Used for screenshots and to try the UI without Docker.
//   node dev/demo-server.mjs   → prints the session cookie to use (also served at /__demo/cookie)
import { execSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
// a long task: 31 attempts with instructions, a stop and a resume, a budget raised, a check that fails then passes
{
  const t = await ctx.svc.createTask({ project: p.name, name: 'agent-analytics', prompt: 'Add the analytics pages for the agents, backed by Postgres with 100 000 rows', successCommand: 'pnpm test && pnpm build', maxCostUsd: 40, maxIterations: 40 }, actor).then((r) => r.task).catch(() => null);
  if (t) {
    await ctx.mgr.stop(t.id).catch(() => {});
    store.db.prepare('DELETE FROM events WHERE task_id=?').run(t.id);
    const ins = store.db.prepare('INSERT INTO events(task_id, iteration, kind, data_json, created_at) VALUES (?,?,?,?,?)');
    const base = Date.now() - 31 * 25 * 60_000;
    const msgs = ['Reading the existing dashboard code and the schema.', 'Adding the aggregation queries for the agent pages.', 'The count query is slow on 100 000 rows: adding an index and a materialized view.', 'Postgres was restarted while running the seed, retrying with a smaller batch.', 'Writing the chart component and its tests.', 'Fixing the type errors reported by the build.', 'The e2e test times out on the aggregation: caching the result for 30 seconds.'];
    store.db.transaction(() => {
      ins.run(t.id, 0, 'status', JSON.stringify({ status: 'queued' }), new Date(base - 1000).toISOString());
      for (let n = 1; n <= 31; n++) {
        const at = (sec) => new Date(base + (n - 1) * 25 * 60_000 + sec * 1000).toISOString();
        if (n === 12) { ins.run(t.id, 11, 'status', JSON.stringify({ status: 'stopped' }), at(-300)); ins.run(t.id, 11, 'user_instruction', JSON.stringify({ text: 'Use the materialized view instead of the live count, the page must load in under a second.', queued: false }), at(-200)); ins.run(t.id, 11, 'status', JSON.stringify({ status: 'queued' }), at(-100)); }
        if (n === 20) { ins.run(t.id, 19, 'status', JSON.stringify({ status: 'budget_exceeded' }), at(-400)); ins.run(t.id, 19, 'system', JSON.stringify({ subtype: 'limits_changed', by: 'mcp:Claude:julien', changes: [], message: 'Budget: $20.00 → $40.00. Applies from the next attempt.' }), at(-300)); ins.run(t.id, 19, 'status', JSON.stringify({ status: 'queued' }), at(-200)); }
        if (n === 27) ins.run(t.id, 26, 'user_instruction', JSON.stringify({ text: 'Do not touch the legacy export, only the new pages.', queued: true }), at(-30));
        ins.run(t.id, n, 'status', JSON.stringify({ status: 'running' }), at(0));
        ins.run(t.id, n, 'assistant_text', JSON.stringify({ text: msgs[n % msgs.length] }), at(20));
        for (let k = 0; k < 4; k++) ins.run(t.id, n, 'tool_use', JSON.stringify({ id: `${n}-${k}`, name: k % 2 ? 'Edit' : 'Bash', input: k % 2 ? { file_path: `src/pages/analytics-${n}.tsx` } : { command: `pnpm vitest run analytics-${n}` } }), at(30 + k));
        if (n === 15) ins.run(t.id, n, 'system', JSON.stringify({ subtype: 'service_incident', service: 'postgres', cause: 'oom', message: 'The service “postgres” was killed because it ran out of memory (limit 512 MB). bivouac started it again; its data volume is intact. Raise the limit with `services.postgres.memory` in bivouac.yml (for example `memory: 2g`) if it keeps happening.' }), at(300));
        ins.run(t.id, n, 'assistant_text', JSON.stringify({ text: n === 31 ? 'All the analytics pages are in place and the build is green.' : `Attempt ${n}: ${msgs[(n + 3) % msgs.length]}` }), at(600));
        ins.run(t.id, n, 'result', JSON.stringify({ subtype: 'success', costUsd: 0.4 + (n % 5) * 0.21, durationMs: 600000 }), at(900));
        ins.run(t.id, n, 'status', JSON.stringify({ status: 'checking' }), at(910));
        ins.run(t.id, n, 'check', JSON.stringify({ command: 'pnpm test && pnpm build', exitCode: n === 31 ? 0 : n % 3 === 0 ? 2 : 1, output: n === 31 ? 'All 142 tests passed\nbuild ok' : `FAIL src/analytics-${n}.test.tsx\n  expected 100000 rows, got 99998` }), at(1200));
      }
      ins.run(t.id, 31, 'status', JSON.stringify({ status: 'succeeded' }), new Date(base + 30 * 25 * 60_000 + 1210_000).toISOString());
    })();
    store.db.prepare("UPDATE tasks SET status='succeeded', iteration=31, cost_usd=21.4, in_tok=2100000, out_tok=310000, started_at=?, finished_at=?, max_cost_usd=40 WHERE id=?").run(new Date(base).toISOString(), new Date(base + 30 * 25 * 60_000 + 1210_000).toISOString(), t.id);
  }
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

// v0.5: preview health, screenshots with problems, an alias and environment snapshots (the fake agent runs in the background: wait for it)
for (const t of store.listTasks()) await ctx.mgr.settled(t.id).catch(() => {});
{
  const now = Date.now(), iso = (msAgo) => new Date(now - msAgo).toISOString();
  const byName = (n) => store.getTaskByName(p.id, n);
  const dm = byName('dark-mode'), co = byName('checkout-fix'), v6 = byName('vite-6');
  if (dm) store.setPreview(dm.id, { state: 'unhealthy', since: iso(95_000), lastHealthyAt: iso(400_000), restarts: 3, cause: 'the dev server exited (code 1); last output: Error: listen EADDRINUSE: address already in use :::5173', nextRetryAt: new Date(now + 24_000).toISOString(), updatedAt: iso(1000) });
  if (co) store.setPreview(co.id, { state: 'healthy', since: iso(3_600_000), lastHealthyAt: iso(2000), restarts: 2, cause: 'the dev server stopped answering on port 5173 (/health)', nextRetryAt: null, updatedAt: iso(1000) });
  if (v6) store.setPreview(v6.id, { state: 'down', since: iso(1_800_000), lastHealthyAt: iso(2_400_000), restarts: 8, cause: 'the dev server exited (code 127); last output: sh: 1: vite: not found', nextRetryAt: null, updatedAt: iso(1000) });
  if (dm) {
    const fx = path.join(import.meta.dirname, 'demo-shots');
    const pages = [['/', 0], ['/settings', 1], ['/checkout', 2]];
    const insShot = store.db.prepare('INSERT INTO shots(task_id,attempt,page,width,http_status,title,ok,blank,problems_json,console_json,failed_json,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const titles = ['Dashboard', 'Settings', 'Checkout'];
    for (const attempt of [1, 2]) {
      store.db.prepare('INSERT OR REPLACE INTO shot_runs(task_id,attempt,check_passed,error) VALUES(?,?,?,NULL)').run(dm.id, attempt, attempt === 2 ? 1 : 0);
      for (const [page, i] of pages) for (const w of [375, 1280]) {
        const bad = attempt === 1 && i === 2;
        const problems = bad ? [{ kind: 'console', message: '1 error(s) in the browser console' }, { kind: 'request', message: '1 request(s) failed' }] : [];
        const id = Number(insShot.run(dm.id, attempt, page, w, 200, titles[i], bad ? 0 : 1, 0, JSON.stringify(problems), JSON.stringify(bad ? ["TypeError: Cannot read properties of undefined (reading 'items')"] : []), JSON.stringify(bad ? [{ url: 'http://127.0.0.1:5173/api/cart', status: 404 }] : []), 1).lastInsertRowid);
        const dir = path.join(dataDir, 'shots', `t${dm.id}`, `a${attempt}`);
        mkdirSync(dir, { recursive: true });
        if (existsSync(path.join(fx, `${i}-${w}.jpg`))) { copyFileSync(path.join(fx, `${i}-${w}.jpg`), path.join(dir, `${id}.jpg`)); copyFileSync(path.join(fx, `${i}-${w}-s.jpg`), path.join(dir, `${id}-s.jpg`)); }
      }
    }
    store.setProjectAlias(p.id, { alias: 'app', taskId: dm.id, publicPaths: ['/api/webhooks/'] });
  }
  store.addSnapshot(p.id, 'a'.repeat(64), 412 * 1024 ** 2); store.addSnapshot(p.id, 'b'.repeat(64), 398 * 1024 ** 2);
  store.db.prepare("UPDATE env_snapshots SET uses=7, created_at=?, last_used_at=? WHERE fingerprint=?").run(iso(5 * 86400_000), iso(3_600_000), 'a'.repeat(64));
  store.db.prepare("UPDATE env_snapshots SET uses=2, created_at=?, last_used_at=? WHERE fingerprint=?").run(iso(12 * 86400_000), iso(4 * 86400_000), 'b'.repeat(64));
  store.setLastFingerprint(p.id, 'a'.repeat(64));
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
