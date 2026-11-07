import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/db.js';
import { TaskManager } from '../src/runner.js';
import { LocalSandbox } from '../src/sandbox.js';
import type { DaemonConfig } from '../src/config.js';

export const FAKE_CLAUDE = path.resolve(import.meta.dirname, '../../task-image/fake-claude/claude');
export const SUPERVISOR = path.resolve(import.meta.dirname, '../../task-image/supervisor.mjs');

export function makeRemote(files: Record<string, string> = { 'README.md': 'hi\n' }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bv-remote-'));
  const sh = (c: string) => execSync(c, { cwd: dir, stdio: 'ignore' });
  sh('git init -q -b main');
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm init');
  return dir;
}

export function makeEnv(overrides: Partial<DaemonConfig> = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bv-data-'));
  const key = randomBytes(32);
  const cfg: DaemonConfig = {
    dataDir, port: 0, bind: '127.0.0.1', accessToken: 'tok', namePrefix: 'bivouac-dev', taskImage: 'x', claudeBin: FAKE_CLAUDE,
    domain: '1-2-3-4.sslip.io', previewScheme: 'http', previewPort: 80, traefikContainer: 'bivouac-dev-traefik', certResolver: null,
    maxParallel: 4, taskUid: 1000, dashboardDir: null, secretKey: key, oauthToken: null, apiKey: null, ...overrides,
  };
  const store = new Store(path.join(dataDir, 'test.db'), key);
  const sandboxes = new Map<number, LocalSandbox>();
  const mgr = new TaskManager(store, cfg, (t) => {
    if (!sandboxes.has(t.id)) sandboxes.set(t.id, new LocalSandbox(path.join(dataDir, 'projects', t.projectName, 'tasks', `t-${t.id}`, 'workspace')));
    return sandboxes.get(t.id)!;
  });
  return { cfg, store, mgr, sandboxes };
}

export function addTask(env: ReturnType<typeof makeEnv>, remote: string, o: { prompt: string; success?: string; maxIterations?: number; maxCost?: number; maxTokens?: number | null; config?: any }) {
  const project = env.store.getProjectByName('demo') ?? env.store.createProject({ name: 'demo', repoUrl: remote, defaultBranch: 'main', config: { dev: { command: 'sleep 1000', port: 5173 }, ...(o.config ?? {}) } });
  return env.store.createTask({ projectId: project.id, title: o.prompt.slice(0, 30), prompt: o.prompt, successCommand: o.success ?? 'true', baseBranch: 'main', maxIterations: o.maxIterations ?? 5, maxCostUsd: o.maxCost ?? 10, maxTokens: o.maxTokens ?? null }, (id) => `agent/t-${id}-x`);
}
