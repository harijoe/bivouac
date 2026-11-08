import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Store } from '../src/db.js';
import { LocalSandbox } from '../src/sandbox.js';
import { buildContext } from '../src/context-build.js';
import { createApp, createInternalApp } from '../src/server.js';
import type { DaemonConfig } from '../src/config.js';
import type { GithubAppCreds } from '../src/githubapp.js';

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

export const TEST_PEM = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
export const APP_CREDS: GithubAppCreds = { id: 1, slug: 'bivouac-test', name: 'bivouac-test', clientId: 'Iv1.test', clientSecret: 'secret', pem: TEST_PEM.privateKey, webhookSecret: 'w', htmlUrl: 'https://github.com/apps/bivouac-test', ownerLogin: 'me' };

export function makeCfg(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bv-data-'));
  return {
    dataDir, port: 0, internalPort: 0, bind: '127.0.0.1', namePrefix: 'bivouac-dev', taskImage: 'x', claudeBin: FAKE_CLAUDE,
    domain: '1-2-3-4.sslip.io', previewScheme: 'https', previewPort: 443, traefikContainer: 'bivouac-dev-traefik', webHost: 'bivouac-dev-web', certResolver: null,
    maxParallel: 4, taskUid: 1000, dashboardDir: null, secretKey: randomBytes(32), executorUrl: null, executorToken: 'xt',
    oauthToken: 'sk-ant-oat01-test', apiKey: null, oauthRedirectAllow: ['https://claude.ai/*', 'https://chatgpt.com/*', 'http://localhost:*/*', 'http://127.0.0.1:*/*'], testMode: true, version: '0.2.0', releasesUrl: 'http://releases.test/releases', daemonImage: 'ghcr.io/x/bivouac-daemon:0.2.0', hostOptDir: '/opt/bivouac', ...overrides,
  };
}

/** A fully wired web service with local (non-Docker) sandboxes and a mocked GitHub. */
export function makeEnv(overrides: Partial<DaemonConfig> = {}, o: { github?: typeof fetch; configured?: boolean } = {}) {
  const cfg = makeCfg(overrides);
  const store = new Store(path.join(cfg.dataDir, 'test.db'), cfg.secretKey);
  const sandboxes = new Map<number, LocalSandbox>();
  const ctx = buildContext({
    cfg, store, fetchImpl: o.github, publicIp: '1.2.3.4', resolve4: async () => [],
    makeSandbox: (t) => {
      if (!sandboxes.has(t.id)) sandboxes.set(t.id, new LocalSandbox(path.join(cfg.dataDir, 'projects', t.projectName, 'tasks', `t-${t.id}`, 'workspace')));
      return sandboxes.get(t.id)!;
    },
  });
  if (o.configured !== false) ctx.gh.save(APP_CREDS);
  const app = createApp(ctx);
  const internal = createInternalApp(ctx);
  // a signed-in administrator
  ctx.auth.upsertUser({ githubId: 42, login: 'julien' }, 'admin');
  const sid = ctx.auth.createSession(42, 'test');
  const cookieName = cfg.previewScheme === 'https' ? '__Host-bv_session' : 'bv_session';
  const H = { cookie: `${cookieName}=${sid}`, 'content-type': 'application/json' };
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = H) => app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { cfg, store, ctx, mgr: ctx.mgr, svc: ctx.svc, app, internal, sandboxes, call, H, sid, cookieName };
}

export function addProject(env: ReturnType<typeof makeEnv>, remote: string, config: any = {}) {
  return env.store.getProjectByName('demo') ?? env.store.createProject({ name: 'demo', repoUrl: remote, defaultBranch: 'main', config: { dev: { command: 'sleep 1000', port: 5173 }, ...config } });
}

let counter = 0;
export function addTask(env: ReturnType<typeof makeEnv>, remote: string, o: { prompt: string; name?: string; success?: string; maxIterations?: number; maxCost?: number; maxTokens?: number | null; config?: any }) {
  const project = addProject(env, remote, o.config);
  const name = o.name ?? `task-${++counter}`;
  return env.store.createTask({ projectId: project.id, name, title: o.prompt.slice(0, 30), prompt: o.prompt, successCommand: o.success ?? 'true', baseBranch: 'main', maxIterations: o.maxIterations ?? 5, maxCostUsd: o.maxCost ?? 10, maxTokens: o.maxTokens ?? null }, (id) => `agent/t-${id}-${name}`);
}

export const repoOf = (env: ReturnType<typeof makeEnv>, t: { id: number }) => path.join(env.sandboxes.get(t.id)!.ws, 'repo');
export const taskDirOf = (env: ReturnType<typeof makeEnv>, t: { id: number }) => path.dirname(env.sandboxes.get(t.id)!.ws);
