// Dev helper: runs the real daemon + dashboard on PORT (default 3100) with *local* sandboxes and the fake
// claude, seeded with a few tasks. Used to take README screenshots and to try the dashboard without Docker.
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Store } from '../dist/db.js';
import { TaskManager } from '../dist/runner.js';
import { LocalSandbox } from '../dist/sandbox.js';
import { createApp } from '../dist/server.js';

const root = path.resolve(import.meta.dirname, '../../..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'bv-demo-'));
const key = randomBytes(32);
const cfg = { dataDir, port: Number(process.env.PORT ?? 3100), bind: '127.0.0.1', accessToken: 'demo-token', namePrefix: 'bivouac-dev', taskImage: 'x',
  claudeBin: path.join(root, 'packages/task-image/fake-claude/claude'), domain: '100-64-1-2.sslip.io', previewScheme: 'http', previewPort: 80,
  traefikContainer: 'x', certResolver: null, maxParallel: 4, taskUid: 1000, dashboardDir: path.join(root, 'packages/dashboard/dist'), secretKey: key, oauthToken: 'demo', apiKey: null };
const store = new Store(path.join(dataDir, 'demo.db'), key);
const sandboxes = new Map();
const mgr = new TaskManager(store, cfg, (t) => {
  if (!sandboxes.has(t.id)) sandboxes.set(t.id, new LocalSandbox(path.join(dataDir, 'ws', String(t.id))));
  return sandboxes.get(t.id);
});
const remote = mkdtempSync(path.join(tmpdir(), 'bv-demo-remote-'));
writeFileSync(path.join(remote, 'README.md'), 'demo\n');
execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init', { cwd: remote });
const p = store.createProject({ name: 'mon-app', repoUrl: remote, defaultBranch: 'main', config: { dev: { command: 'echo "VITE ready in 312 ms"; sleep 1000', port: 5173 } } });
store.createProject({ name: 'api-gateway', repoUrl: remote, defaultBranch: 'main' });
const mk = (prompt, o = {}) => store.createTask({ projectId: p.id, title: prompt.split(' FAKE')[0], prompt, successCommand: 'grep -q ok fake-output.txt', baseBranch: 'main', maxIterations: 6, maxCostUsd: 5, ...o }, (id) => `agent/t-${id}-demo`);
const tasks = [
  mk('Add a button that increments a counter, with a test FAKE_SCENARIO=fail-then-succeed FAKE_COST=0.42'),
  mk('Refactor the settings page FAKE_SCENARIO=succeed FAKE_COST=0.18'),
  mk('Migrate the build to Vite 6 FAKE_SCENARIO=always-fail FAKE_COST=2.2', { maxCostUsd: 4 }),
  mk('Fix flaky checkout test FAKE_SCENARIO=fail-then-succeed FAKE_DELAY=2500 FAKE_COST=0.3'),
];
for (const t of tasks) mgr.enqueue(t.id);
serve({ fetch: createApp(cfg, store, mgr).fetch, port: cfg.port, hostname: '127.0.0.1' }, () => console.log(`demo on http://127.0.0.1:${cfg.port} (token: demo-token)`));
