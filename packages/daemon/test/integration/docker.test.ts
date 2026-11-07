// Real Docker + real Traefik + fake claude. Everything is prefixed `bivouac-dev-`.
// Run: pnpm test:integration   (builds the task image if BIVOUAC_TEST_IMAGE is not set)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Dockerode from 'dockerode';
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { Store } from '../../src/db.js';
import { TaskManager } from '../../src/runner.js';
import { DockerSandbox } from '../../src/sandbox.js';
import { makeEnv } from '../helpers.js';

const docker = new Dockerode();
const PREFIX = 'bivouac-dev';
const TRAEFIK = `${PREFIX}-traefik`;
const HTTP_PORT = Number(process.env.BIVOUAC_TEST_PORT ?? 8088);
const IMAGE = process.env.BIVOUAC_TEST_IMAGE ?? `${PREFIX}-task:test`;
const repoRoot = path.resolve(import.meta.dirname, '../../../..');

async function waitFor<T>(fn: () => Promise<T | false>, ms = 120000, every = 1000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try { const r = await fn(); if (r) return r; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timeout waiting (last error: ${String(last)})`);
}
const get = (host: string, p: string) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    // fetch() ignores a custom Host header, so use node:http
    const req = httpRequest({ host: '127.0.0.1', port: HTTP_PORT, path: p, headers: { host } }, (res) => {
      let text = '';
      res.on('data', (b) => (text += b));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end();
  });

let env: ReturnType<typeof makeEnv>;
let mgr: TaskManager;
let store: Store;
let remote: string;

beforeAll(async () => {
  if (!process.env.BIVOUAC_TEST_IMAGE) execSync(`docker build -q -t ${IMAGE} ${path.join(repoRoot, 'packages/task-image')}`, { stdio: 'inherit' });
  await docker.getContainer(TRAEFIK).remove({ force: true }).catch(() => {});
  const tr = await docker.createContainer({
    name: TRAEFIK, Image: 'traefik:v3.6', Labels: { 'bivouac.managed': 'false', 'bivouac.dev': 'true' },
    Cmd: ['--providers.docker=true', '--providers.docker.exposedbydefault=false', '--entrypoints.web.address=:80', '--log.level=INFO'],
    ExposedPorts: { '80/tcp': {} },
    HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'], PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(HTTP_PORT) }] } },
  });
  await tr.start();

  // Example project as a local git repo (the daemon clones it host-side)
  remote = mkdtempSync(path.join(tmpdir(), 'bv-it-remote-'));
  cpSync(path.join(repoRoot, 'examples/vite-app'), remote, { recursive: true });
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init', { cwd: remote });

  env = makeEnv({ taskImage: IMAGE, claudeBin: '/opt/bivouac/fake-claude', previewPort: HTTP_PORT, traefikContainer: TRAEFIK, domain: '127-0-0-1.sslip.io', namePrefix: PREFIX });
  store = env.store;
  const docker2 = new Dockerode();
  mgr = new TaskManager(store, env.cfg, (t) => new DockerSandbox(docker2, { namePrefix: PREFIX, taskId: t.id, traefikContainer: TRAEFIK, uid: env.cfg.taskUid }));
}, 300000);

const createdTasks: number[] = [];
afterAll(async () => {
  for (const id of createdTasks) await mgr?.destroy(id, true).catch(() => {});
  await docker.getContainer(TRAEFIK).remove({ force: true }).catch(() => {});
}, 120000);

describe('docker integration', () => {
  it('runs two parallel tasks of the same project, independent, each with a live preview, and cleans up', async () => {
    const project = store.createProject({ name: 'demo', repoUrl: remote, defaultBranch: 'main' });
    const mk = (prompt: string, success: string) => {
      const t = store.createTask({ projectId: project.id, title: prompt, prompt, successCommand: success, baseBranch: 'main', maxIterations: 4, maxCostUsd: 5 }, (id) => `agent/t-${id}-x`);
      createdTasks.push(t.id);
      return t;
    };
    const a = mk('task A', 'pnpm test && pnpm build');
    const b = mk('task B FAKE_SCENARIO=fail-then-succeed', 'grep -q ok fake-output.txt && pnpm test');
    mgr.enqueue(a.id); mgr.enqueue(b.id);

    // containers + networks exist, prefixed, non-root, no docker socket
    await waitFor(async () => (await docker.listContainers({ filters: { name: [`${PREFIX}-task-`] } })).length === 2);
    const info = await docker.getContainer(`${PREFIX}-task-${a.id}`).inspect();
    expect(info.Config.User).toBe('node');
    expect(info.HostConfig.Binds!.join(' ')).not.toContain('docker.sock');
    expect(info.Config.Labels['traefik.enable']).toBe('true');
    expect(info.HostConfig.NanoCpus).toBe(2e9);

    // previews answer through Traefik, on distinct hostnames
    const hostA = `t-${a.id}.demo.127-0-0-1.sslip.io`, hostB = `t-${b.id}.demo.127-0-0-1.sslip.io`;
    for (const h of [hostA, hostB]) {
      const r = await waitFor(async () => { const x = await get(h, '/'); return x.status === 200 && x.text.includes('<div id="root">') ? x : false; }, 240000, 2000);
      expect(r.text).toContain('bivouac example');
    }

    await Promise.all([mgr.settled(a.id), mgr.settled(b.id)]);
    expect(store.getTask(a.id)!.status).toBe('succeeded');
    expect(store.getTask(b.id)!.status).toBe('succeeded');
    expect(store.getTask(a.id)!.iteration).toBe(1);
    expect(store.getTask(b.id)!.iteration).toBe(2);
    expect(store.getTask(b.id)!.previewUrl).toBe(`http://${hostB}:${HTTP_PORT}`);

    // independence: a file written in A's workspace shows up in A's preview only (live dev server)
    const marker = `MARKER_${Date.now()}`;
    writeFileSync(path.join(mgr.repoDir(store.getTask(a.id)!), 'src/App.tsx'), readFileSync(path.join(mgr.repoDir(store.getTask(a.id)!), 'src/App.tsx'), 'utf8').replace('Hello from', `${marker} Hello from`));
    await waitFor(async () => (await get(hostA, '/src/App.tsx')).text.includes(marker), 30000, 500);
    expect((await get(hostB, '/src/App.tsx')).text).not.toContain(marker);
    expect(readFileSync(path.join(mgr.repoDir(store.getTask(b.id)!), 'fake-output.txt'), 'utf8')).toBe('ok\n');
    expect(store.getTask(a.id)!.branch).not.toBe(store.getTask(b.id)!.branch);

    // dev server logs are readable
    expect(await mgr.devLogs(a.id)).toContain('ready in');

    // cleanup
    await mgr.destroy(a.id, true); await mgr.destroy(b.id, true);
    const left = await docker.listContainers({ all: true, filters: { name: [`${PREFIX}-task-`] } });
    expect(left).toHaveLength(0);
    const nets = await docker.listNetworks({ filters: { name: [`${PREFIX}-task-`] } });
    expect(nets).toHaveLength(0);
  });
});
