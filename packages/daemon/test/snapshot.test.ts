import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addTask, makeEnv, makeRemote, repoOf } from './helpers.js';
import { fingerprint } from '../src/snapshot.js';

const SETUP = 'if [ -d node_modules/dep ]; then echo warm >> ../setup-log; else echo cold >> ../setup-log; fi; mkdir -p node_modules/dep; echo hi > node_modules/dep/index.js; echo SECRET=1 > .env; echo "log" > debug.log';
const files = { 'README.md': 'x', 'pnpm-lock.yaml': 'lock: 1\n', 'package.json': '{"name":"a","scripts":{"dev":"x"},"dependencies":{"left-pad":"1"}}', '.gitignore': 'node_modules/\n.env\n*.log\n' };
const commit = (dir: string, f: Record<string, string>) => { for (const [k, v] of Object.entries(f)) writeFileSync(path.join(dir, k), v); execSync('git add -A && git -c user.name=t -c user.email=t@t commit -qm change', { cwd: dir, stdio: 'ignore' }); };
const log = (env: ReturnType<typeof makeEnv>, t: { id: number }) => readFileSync(path.join(env.sandboxes.get(t.id)!.ws, 'setup-log'), 'utf8').trim().split('\n');
async function runTask(env: ReturnType<typeof makeEnv>, remote: string, name: string, extra: { prompt?: string } = {}) {
  const t = addTask(env, remote, { prompt: extra.prompt ?? 'do it', name, config: { setup: SETUP } });
  env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
  return env.store.getTask(t.id)!;
}
const subtypes = (env: ReturnType<typeof makeEnv>, id: number) => env.store.listEvents(id).filter((e) => e.kind === 'system').map((e) => e.data.subtype as string).filter((s) => s?.startsWith('snapshot'));

describe('environment fingerprint', () => {
  const base = { files: { 'pnpm-lock.yaml': 'a', 'package.json': '{"scripts":{"x":"1"},"dependencies":{"a":"1"}}' } as Record<string, string | null>, setup: 'pnpm i', runtime: 'node@26', image: 'sha256:img' };
  it('changes with lock files, dependencies, setup, runtime and image, but not with unrelated edits', () => {
    const fp = fingerprint(base)!;
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint({ ...base })).toBe(fp);
    expect(fingerprint({ ...base, files: { ...base.files, 'pnpm-lock.yaml': 'b' } })).not.toBe(fp);
    expect(fingerprint({ ...base, files: { ...base.files, 'package.json': '{"scripts":{"x":"1"},"dependencies":{"a":"2"}}' } })).not.toBe(fp);
    expect(fingerprint({ ...base, setup: 'pnpm i --frozen-lockfile' })).not.toBe(fp);
    expect(fingerprint({ ...base, runtime: 'node@25' })).not.toBe(fp);
    expect(fingerprint({ ...base, image: 'sha256:other' })).not.toBe(fp);
    // a renamed script is not a reason to reinstall
    expect(fingerprint({ ...base, files: { ...base.files, 'package.json': '{"scripts":{"y":"2"},"dependencies":{"a":"1"}}' } })).toBe(fp);
  });
  it('is null without a lock file', () => {
    expect(fingerprint({ ...base, files: { 'package.json': '{}' } })).toBeNull();
  });
});

describe('environment snapshots', () => {
  it('first task builds one, the next task of the project starts from it (and never carries secrets or logs)', async () => {
    const env = makeEnv(); const remote = makeRemote(files);
    const a = await runTask(env, remote, 'first');
    expect(a.status).toBe('succeeded');
    expect(log(env, a)).toEqual(['cold']);
    expect(subtypes(env, a.id)).toEqual(['snapshot_created']);
    const [snap] = env.store.listSnapshots(a.projectId);
    expect(snap.bytes).toBeGreaterThan(0);
    const archive = path.join(env.cfg.dataDir, 'projects', 'demo', 'snapshots', `${snap.fingerprint}.tar`);
    expect(existsSync(archive)).toBe(true);
    const listing = execSync(`tar -tf ${archive}`, { encoding: 'utf8' });
    expect(listing).toContain('node_modules/dep/index.js');
    expect(listing).not.toMatch(/\.env|debug\.log/);
    const b = await runTask(env, remote, 'second');
    expect(b.status).toBe('succeeded');
    expect(log(env, b)).toEqual(['warm']); // setup still ran, on top of the restored dependencies
    expect(subtypes(env, b.id)).toEqual(['snapshot_restored']);
    expect(env.store.listSnapshots(a.projectId)).toHaveLength(1);
    expect(env.store.listSnapshots(a.projectId)[0]).toMatchObject({ uses: 1, current: true });
    expect(readFileSync(path.join(repoOf(env, b), 'node_modules/dep/index.js'), 'utf8')).toBe('hi\n');
  });

  it('is not used when the lock file or the setup command change (tool versions and image: see the fingerprint test)', async () => {
    const env = makeEnv(); const remote = makeRemote(files);
    await runTask(env, remote, 'one');
    commit(remote, { 'pnpm-lock.yaml': 'lock: 2\n' });
    const b = await runTask(env, remote, 'two');
    expect(log(env, b)).toEqual(['cold']);
    expect(subtypes(env, b.id)).toEqual(['snapshot_created']);
    expect(env.store.listSnapshots(b.projectId)).toHaveLength(2);
    env.store.updateProject(b.projectId, { config: { setup: SETUP + '; true' } });
    const c = await runTask(env, remote, 'three');
    expect(log(env, c)).toEqual(['cold']);
    expect(env.store.listSnapshots(b.projectId)).toHaveLength(3);
  });

  it('falls back to a normal setup when the archive is missing', async () => {
    const env = makeEnv(); const remote = makeRemote(files);
    await runTask(env, remote, 'one');
    const [snap] = env.store.listSnapshots(1);
    execSync(`rm ${path.join(env.cfg.dataDir, 'projects/demo/snapshots', snap.fingerprint + '.tar')}`);
    const b = await runTask(env, remote, 'two');
    expect(b.status).toBe('succeeded');
    expect(log(env, b)).toEqual(['cold']);
    expect(subtypes(env, b.id)).toEqual(['snapshot_missing', 'snapshot_created']);
    expect(env.store.listSnapshots(1)).toHaveLength(1);
  });

  it('discards a snapshot that makes setup fail and runs setup again from scratch', async () => {
    const env = makeEnv(); const remote = makeRemote(files);
    const poisoned = 'if [ -f node_modules/bad ] && [ ! -f ../allow-bad ]; then exit 7; fi; mkdir -p node_modules; touch node_modules/bad; touch ../allow-bad';
    const mk = (name: string) => { const t = addTask(env, remote, { prompt: 'x', name, config: { setup: poisoned } }); env.mgr.enqueue(t.id); return t; };
    const a = mk('one'); await env.mgr.settled(a.id);
    expect(env.store.getTask(a.id)!.status).toBe('succeeded');
    const b = mk('two'); await env.mgr.settled(b.id);
    expect(env.store.getTask(b.id)!.status).toBe('succeeded');
    expect(subtypes(env, b.id)).toEqual(['snapshot_restored', 'snapshot_discarded', 'snapshot_created']);
    expect(env.store.listSnapshots(1)).toHaveLength(1);
  });

  it('keeps at most 3 snapshots per project, removing the least recently used archive', async () => {
    const env = makeEnv(); const remote = makeRemote(files);
    for (let i = 1; i <= 4; i++) { commit(remote, { 'pnpm-lock.yaml': `lock: ${i + 10}\n` }); await runTask(env, remote, `t${i}`); }
    const snaps = env.store.listSnapshots(1);
    expect(snaps).toHaveLength(3);
    const dir = path.join(env.cfg.dataDir, 'projects/demo/snapshots');
    expect(execSync(`ls ${dir}`, { encoding: 'utf8' }).trim().split('\n')).toHaveLength(3);
  });

  it('keeps no snapshot without a lock file', async () => {
    const env = makeEnv(); const remote = makeRemote({ 'README.md': 'x', '.gitignore': 'node_modules/\n' });
    const a = await runTask(env, remote, 'one');
    expect(a.status).toBe('succeeded');
    expect(subtypes(env, a.id)).toEqual([]);
    expect(env.store.listSnapshots(a.projectId)).toEqual([]);
  });

  it('is listed, rebuilt (discarded) and deleted through the API', async () => {
    const env = makeEnv(); const remote = makeRemote(files);
    await runTask(env, remote, 'one');
    commit(remote, { 'pnpm-lock.yaml': 'lock: 9\n' });
    await runTask(env, remote, 'two');
    const l: any = await (await env.call('GET', '/api/projects/1/snapshots')).json();
    expect(l).toMatchObject({ keep: 3 });
    expect(l.snapshots).toHaveLength(2);
    expect(l.current).toBe(l.snapshots.find((s: any) => s.current).fingerprint);
    const del = await env.call('DELETE', `/api/projects/1/snapshots/${l.snapshots[1].id}`);
    expect(del.status).toBe(200);
    expect(existsSync(path.join(env.cfg.dataDir, 'projects/demo/snapshots', `${l.snapshots[1].fingerprint}.tar`))).toBe(false);
    const rb: any = await (await env.call('POST', '/api/projects/1/snapshots/rebuild')).json();
    expect(rb.removed).toBe(1);
    expect(((await (await env.call('GET', '/api/projects/1/snapshots')).json()) as any).snapshots).toEqual([]);
    const c = await runTask(env, remote, 'three');
    expect(log(env, c)).toEqual(['cold']);
    expect(env.store.listSnapshots(1)).toHaveLength(1);
  });
});
