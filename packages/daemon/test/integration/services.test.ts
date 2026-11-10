// Real Docker: limits of sidecar services (default, update of an existing container) and detection of a memory kill.
// Everything is prefixed `bivouac-dev-`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Dockerode from 'dockerode';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../../src/db.js';
import { DockerSandbox } from '../../src/sandbox.js';
import { ServiceWatch } from '../../src/service-watch.js';

const docker = new Dockerode();
const TASK = 91001;
const IMAGE = 'alpine:3';
let sb: DockerSandbox;
let store: Store;
const dir = mkdtempSync(path.join(tmpdir(), 'bv-svc-'));
const svc = (n: string) => docker.getContainer(`bivouac-dev-svc-task-${TASK}-svc-${n}`);

beforeAll(async () => {
  await new Promise<void>((res, rej) => docker.pull(IMAGE, (e: Error | null, st: NodeJS.ReadableStream) => (e ? rej(e) : docker.modem.followProgress(st, (e2: Error | null) => (e2 ? rej(e2) : res())))));
  sb = new DockerSandbox(docker, { namePrefix: 'bivouac-dev-svc', taskId: TASK, project: 'demo', dataDir: dir, image: IMAGE, traefikContainer: 'bivouac-dev-svc-no-traefik', uid: 1000 });
  store = new Store(path.join(dir, 'db'), randomBytes(32));
}, 120_000);
afterAll(async () => { await sb.destroy().catch(() => {}); }, 60_000);

describe('service resources (real Docker)', () => {
  it('a service gets 1 GB by default, and a changed limit is applied to the existing container', async () => {
    const spec = { taskId: TASK, project: 'demo', env: {}, services: { db: { image: IMAGE } } };
    await sb.start(spec);
    let i = await svc('db').inspect();
    expect(i.HostConfig.Memory).toBe(1024 ** 3);
    expect(i.HostConfig.NanoCpus).toBe(1e9);
    await sb.start({ ...spec, services: { db: { image: IMAGE, memory: '256m', cpus: 0.5 } } });
    i = await svc('db').inspect();
    expect(i.HostConfig.Memory).toBe(256 * 1024 ** 2);
    expect(i.HostConfig.NanoCpus).toBe(5e8);
  }, 120_000);

  it('a service killed for memory is reported in the task history with its limit, then started again', async () => {
    await svc('db').remove({ force: true }).catch(() => {});
    const c = await docker.createContainer({
      name: `bivouac-dev-svc-task-${TASK}-svc-hog`, Image: IMAGE, Labels: { 'bivouac.managed': 'true', 'bivouac.task': String(TASK), 'bivouac.service': 'hog' },
      Cmd: ['sh', '-c', 'a=xxxxxxxxxx; while true; do a="$a$a"; done'], HostConfig: { Memory: 16 * 1024 ** 2, MemorySwap: 16 * 1024 ** 2 },
    });
    await c.start();
    const killed = async () => (await sb.serviceStates()).find((s) => s.name === 'hog' && !s.running && (s.oomKilled || s.exitCode === 137));
    for (let n = 0; n < 60 && !(await killed()); n++) await new Promise((r) => setTimeout(r, 500));
    const state = await killed();
    expect(state?.memoryLimit).toBe(16 * 1024 ** 2);

    // a watcher that started before the kill: a fresh baseline would hide it, so check from an empty one
    const project = store.createProject({ name: 'demo', repoUrl: 'x', defaultBranch: 'main' });
    const t = store.createTask({ projectId: project.id, name: 't', title: 't', prompt: 'p', successCommand: 'true', baseBranch: 'main', maxIterations: 1, maxCostUsd: 1 }, () => 'b');
    const watch = new ServiceWatch(store, t.id, sb);
    await watch.check();
    const ev = store.listEvents(t.id).filter((e) => e.data?.subtype === 'service_incident');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ service: 'hog', cause: 'oom', memoryLimit: 16 * 1024 ** 2 });
    expect(ev[0].data.message).toMatch(/ran out of memory.*limit 16 MB/);
    expect(watch.takeNotices()).toHaveLength(1);
  }, 120_000);
});
