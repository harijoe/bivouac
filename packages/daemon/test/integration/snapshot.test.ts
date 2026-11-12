// Real Docker, the real task image, a realistic project (examples/node-postgres: pnpm + a Postgres sidecar, installed from the npm registry).
// Measures what an environment snapshot saves: time until the agent can start and until the preview answers, for
//   A. the first task of a project (nothing cached), B. a later task that starts from the snapshot, C. a later task without snapshot
//   (what v0.4 did: the tool cache volume is warm, dependencies are downloaded again).
// Needs network access (npm registry, Docker Hub). Results are printed and written to $BIVOUAC_BENCH_OUT (default /tmp/bivouac-bench-snapshot.json).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Dockerode from 'dockerode';
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../src/db.js';
import { DockerSandbox } from '../../src/sandbox.js';
import { TaskManager } from '../../src/runner.js';
import { makeCfg } from '../helpers.js';

const docker = new Dockerode();
const PFX = 'bivouac-dev-snap';
const IMAGE = process.env.BIVOUAC_TEST_IMAGE ?? 'bivouac-dev-task:test';
const repoRoot = path.resolve(import.meta.dirname, '../../../..');
let dir: string, store: Store, mgr: TaskManager, remote: string;
const cfg = makeCfg({ namePrefix: PFX, taskImage: IMAGE, claudeBin: '/opt/bivouac/fake-claude', traefikContainer: `${PFX}-none` });

beforeAll(() => {
  // the task image may not exist yet when this file runs alone
  try { execSync(`docker image inspect ${IMAGE}`, { stdio: 'ignore' }); } catch { execSync(`docker build -q -t ${IMAGE} ${path.join(repoRoot, 'packages/task-image')}`, { stdio: 'ignore', timeout: 600_000 }); }
  dir = cfg.dataDir;
  remote = mkdtempSync(path.join(tmpdir(), 'bv-bench-repo-'));
  cpSync(path.join(repoRoot, 'examples/node-postgres'), remote, { recursive: true });
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init', { cwd: remote });
  store = new Store(path.join(dir, 'db'), cfg.secretKey);
  mgr = new TaskManager(store, cfg, (t) => new DockerSandbox(docker, { namePrefix: PFX, taskId: t.id, project: t.projectName, dataDir: dir, image: IMAGE, traefikContainer: cfg.traefikContainer, uid: 1000 }));
});
const created: number[] = [];
afterAll(async () => {
  for (const id of created) await mgr.destroy(id, true).catch(() => {});
  for (const v of (await docker.listVolumes({ filters: { name: [PFX] } }).catch(() => ({ Volumes: [] as { Name: string }[] }))).Volumes ?? []) await docker.getVolume(v.Name).remove({ force: true }).catch(() => {});
}, 120_000);

async function timed(name: string) {
  const project = store.getProjectByName('bench') ?? store.createProject({ name: 'bench', repoUrl: remote, defaultBranch: 'main' });
  const t = store.createTask({ projectId: project.id, name, title: name, prompt: 'make the check pass', successCommand: 'for i in $(seq 1 90); do node scripts/check.mjs && exit 0; sleep 1; done; exit 1', baseBranch: 'main', maxIterations: 4, maxCostUsd: 5 }, (id) => `agent/t-${id}-${name}`);
  created.push(t.id);
  const t0 = Date.now();
  mgr.enqueue(t.id);
  await mgr.settled(t.id);
  const done = store.getTask(t.id)!;
  const ev = store.listEvents(t.id);
  const at = (f: (e: (typeof ev)[number]) => boolean) => { const e = ev.find(f); return e ? (Date.parse(e.createdAt) - t0) / 1000 : null; };
  // the task can finish before the dev server has booted: wait for the supervisor to report it healthy
  let health: any = {};
  for (let i = 0; i < 120; i++) {
    health = JSON.parse((await mgr.sandboxFor(done).readFile('.bivouac/health.json')) ?? '{}');
    if (health.state === 'healthy') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const setupStart = at((e) => e.data?.subtype === 'setup');
  return {
    task: name, status: done.status, attempts: done.iteration,
    agentReadyS: at((e) => e.kind === 'status' && e.data.status === 'running'),
    previewAvailableS: health.lastHealthyAt ? (Date.parse(health.lastHealthyAt) - t0) / 1000 : null,
    setupStartS: setupStart, snapshot: ev.filter((e) => String(e.data?.subtype).startsWith('snapshot')).map((e) => e.data.subtype as string),
    snapshotMessages: ev.filter((e) => String(e.data?.subtype).startsWith('snapshot')).map((e) => e.data.message as string),
    setupOutput: ev.filter((e) => e.data?.subtype === 'output' && e.data?.label === 'setup').map((e) => String(e.data.text)).join('').slice(-1500),
    snapshotMs: ev.find((e) => e.data?.subtype === 'snapshot_restored')?.data.ms ?? null,
    snapshotBytes: store.listSnapshots(1)[0]?.bytes ?? null,
    devLog: ((await mgr.sandboxFor(done).readFile('.bivouac/dev.log')) ?? '').split('\n').slice(-12).join('\n'),
    health: health.state ?? null,
  };
}

describe('task start-up time with and without an environment snapshot (real Docker)', () => {
  it('measures A (first task), B (from the snapshot) and C (no snapshot)', async () => {
    const A = await timed('a-first');
    expect(A.status).toBe('succeeded');
    expect(A.snapshot).toContain('snapshot_created');
    const B = await timed('b-snapshot');
    expect(B.status).toBe('succeeded');
    expect(B.snapshot, JSON.stringify([B.snapshotMessages, B.setupOutput])).toEqual(['snapshot_restored']); // not discarded: setup ran fine on top of the restored files
    // what v0.4 did for the third task: no snapshot, same caches otherwise
    for (const s of store.listSnapshots(1)) { await mgr.removeSnapshotFile('bench', s.fingerprint); store.deleteSnapshot(s.id); }
    const C = await timed('c-no-snapshot');
    expect(C.status).toBe('succeeded');
    const out = { image: IMAGE, project: 'examples/node-postgres (pnpm 10, ~800 packages: next, react, vite, vitest, storybook, drizzle, eslint… + postgres:16-alpine)', A, B, C };
    console.log(JSON.stringify(out, null, 2));
    writeFileSync(process.env.BIVOUAC_BENCH_OUT ?? '/tmp/bivouac-bench-snapshot.json', JSON.stringify(out, null, 2));
    expect(B.agentReadyS!).toBeLessThan(C.agentReadyS!);
    expect(B.previewAvailableS!).toBeLessThan(C.previewAvailableS!);
  }, 900_000);
});
