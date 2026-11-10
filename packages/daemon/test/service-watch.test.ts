import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { LocalSandbox, type ServiceState } from '../src/sandbox.js';
import { ServiceWatch, describeIncident } from '../src/service-watch.js';
import { TaskLogs } from '../src/logs.js';

class FakeSandbox extends LocalSandbox {
  states: ServiceState[] = [];
  restarted: string[] = [];
  /** when true, restartService brings the service back (new start time) */
  heals = true;
  async serviceStates() { return this.states.map((s) => ({ ...s })); }
  async restartService(name: string) {
    this.restarted.push(name);
    if (this.heals) this.states = this.states.map((s) => (s.name === name ? { ...s, running: true, oomKilled: false, exitCode: null, startedAt: `s${this.restarted.length}`, finishedAt: s.finishedAt } : s));
  }
}
const pg = (o: Partial<ServiceState> = {}): ServiceState => ({ name: 'postgres', running: true, oomKilled: false, exitCode: null, restartCount: 0, startedAt: 's0', finishedAt: '0', memoryLimit: 512 * 1024 ** 2, ...o });

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bv-sw-'));
  const store = new Store(path.join(dir, 'db'), randomBytes(32));
  const p = store.createProject({ name: 'demo', repoUrl: 'x', defaultBranch: 'main' });
  const t = store.createTask({ projectId: p.id, name: 't', title: 't', prompt: 'p', successCommand: 'true', baseBranch: 'main', maxIterations: 1, maxCostUsd: 1 }, () => 'b');
  const sb = new FakeSandbox(path.join(dir, 'ws'));
  return { store, t, sb, watch: new ServiceWatch(store, t.id, sb), dir };
}
const incidents = (s: Store, id: number) => s.listEvents(id).filter((e) => e.data?.subtype === 'service_incident');

describe('service watch', () => {
  it('says nothing while services run, and ignores what happened before it started', async () => {
    const { store, t, sb, watch } = setup();
    sb.states = [pg({ running: false, oomKilled: true, exitCode: 137, finishedAt: 'old' })];
    await watch.baseline();
    await watch.check();
    expect(incidents(store, t.id)).toHaveLength(0);
  });

  it('reports a memory kill with the limit, restarts the service and queues a note for the agent', async () => {
    const { store, t, sb, watch } = setup();
    sb.states = [pg()];
    await watch.baseline();
    sb.states = [pg({ running: false, oomKilled: true, exitCode: 137, finishedAt: 'now' })];
    await watch.check();
    const [ev] = incidents(store, t.id);
    expect(ev.data).toMatchObject({ service: 'postgres', cause: 'oom', memoryLimit: 512 * 1024 ** 2 });
    expect(ev.data.message).toContain('ran out of memory');
    expect(ev.data.message).toContain('512 MB');
    expect(ev.data.message).toContain('services.postgres.memory');
    expect(sb.restarted).toEqual(['postgres']);
    expect(watch.takeNotices()).toHaveLength(1);
    expect(watch.takeNotices()).toHaveLength(0);
    await watch.check(); // restarted and healthy: no second report
    expect(incidents(store, t.id)).toHaveLength(1);
  });

  it('reports a restart done by Docker and an unexplained stop, and gives up after a few restarts', async () => {
    const { store, t, sb, watch } = setup();
    sb.states = [pg()];
    await watch.baseline();
    sb.states = [pg({ restartCount: 1, startedAt: 's9' })];
    await watch.check();
    expect(incidents(store, t.id)[0].data).toMatchObject({ cause: 'restart' });
    sb.heals = false;
    for (let i = 0; i < 8; i++) { sb.states = [pg({ running: false, exitCode: 1, finishedAt: `f${i}` })]; await watch.check(); }
    expect(sb.restarted).toHaveLength(5);
    expect(incidents(store, t.id).at(-1)!.data.message).toContain('gave up');
  });

  it('shows up in the log of the service', async () => {
    const { store, t, sb, watch } = setup();
    sb.states = [pg()];
    await watch.baseline();
    sb.states = [pg({ running: false, oomKilled: true, exitCode: 137, finishedAt: 'now' })];
    await watch.check();
    const logs = new TaskLogs(store, () => sb);
    const page = await logs.page(store.getTask(t.id)!, 'svc:postgres');
    expect(page.lines.some((l) => l.text.startsWith('[bivouac] The service “postgres” was killed'))).toBe(true);
  });

  it('describes sizes in the unit people expect', () => {
    expect(describeIncident(pg({ memoryLimit: 1024 ** 3 }), 'restarted').message).toContain('1 GB');
  });
});
