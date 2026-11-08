import { describe, it, expect } from 'vitest';
import { compareSemver } from '@bivouac/shared';
import { pickLatestRelease } from '../src/updates.js';
import { addTask, makeEnv, makeRemote } from './helpers.js';

const rel = (tag: string, extra: object = {}) => ({ tag_name: tag, name: tag, body: `notes ${tag}`, html_url: `https://x/${tag}`, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', ...extra });
const releases = (list: object[]) => (async () => new Response(JSON.stringify(list), { status: 200 })) as unknown as typeof fetch;

async function build(list: object[], opts: { now?: () => Date; running?: boolean } = {}) {
  const { buildContext } = await import('../src/context-build.js');
  const base = makeEnv();
  const started: string[] = [];
  const ctx = buildContext({ cfg: base.cfg, store: base.store, makeSandbox: () => { throw new Error('unused'); }, fetchImpl: releases(list), now: opts.now, update: { updateStart: async (v) => { started.push(v); }, updateRunning: async () => opts.running ?? false } });
  ctx.auth.upsertUser({ githubId: 1, login: 'julien' }, 'admin');
  return { ...base, ctx, started, u: ctx.updates };
}

describe('versions', () => {
  it('compares semver, pre-releases older than their release', () => {
    expect(compareSemver('0.3.0', '0.2.9')).toBeGreaterThan(0);
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemver('x', '1.0.0')).toBeNaN();
  });
  it('ignores drafts and pre-releases, takes the highest published release', () => {
    const r = pickLatestRelease([rel('v0.4.0', { draft: true }), rel('v0.4.0-rc.1', { prerelease: true }), rel('v0.3.0'), rel('v0.2.0'), rel('not-a-version')]);
    expect(r?.version).toBe('0.3.0');
    expect(r?.notes).toBe('notes v0.3.0');
    expect(pickLatestRelease([rel('v1.0.0-beta.1')])).toBeNull();
    expect(pickLatestRelease('nope')).toBeNull();
  });
});

describe('update detection and start', () => {
  it('announces a newer version, not an older or equal one', async () => {
    const a = await build([rel('v0.3.0'), rel('v0.2.0')]);
    await a.u.check();
    expect(a.u.status().available?.version).toBe('0.3.0');
    const b = await build([rel('v0.2.0')]);
    await b.u.check();
    expect(b.u.status().available).toBeNull();
    expect(b.u.status(false).available).toBeNull();
  });
  it('reports a failed check without losing the previous result', async () => {
    const a = await build([rel('v0.3.0')]);
    await a.u.check();
    (a.u as any).fetchImpl = async () => new Response('x', { status: 500 });
    await a.u.check();
    expect(a.u.status().error).toMatch(/500/);
    expect(a.u.status().available?.version).toBe('0.3.0');
  });
  it('starts at once when idle, audits who did it', async () => {
    const a = await build([rel('v0.3.0')]);
    await a.u.check();
    expect(await a.u.start('idle', 'julien')).toEqual({ started: true, scheduled: false });
    expect(a.started).toEqual(['0.3.0']);
    expect(a.ctx.auth.listAudit(10).some((e: any) => e.action === 'update_started' && e.actor === 'julien')).toBe(true);
  });
  it('schedules while a task runs, blocks new tasks with a clear message, then starts when idle', async () => {
    const a = await build([rel('v0.3.0')]);
    await a.u.check();
    const remote = makeRemote();
    const t = addTask(a, remote, { prompt: 'x' });
    a.store.setStatus(t.id, 'running');
    expect(await a.u.start('idle', 'julien')).toEqual({ started: false, scheduled: true });
    expect(a.started).toEqual([]);
    // new tasks are refused with an explanation
    await expect(a.ctx.svc.createTask({ project: 'demo', name: 'another', prompt: 'y' }, { kind: 'mcp', label: 'chat' })).rejects.toThrow(/waiting for the running tasks.*retry in a few minutes/s);
    await a.u.tick();
    expect(a.started).toEqual([]); // still running
    a.store.setStatus(t.id, 'succeeded');
    await a.u.tick();
    expect(a.started).toEqual(['0.3.0']);
    expect(a.u.scheduled()).toBeNull();
  });
  it('the schedule can be cancelled', async () => {
    const a = await build([rel('v0.3.0')]);
    await a.u.check();
    const t = addTask(a, makeRemote(), { prompt: 'x' });
    a.store.setStatus(t.id, 'running');
    await a.u.start('idle', 'julien');
    a.u.cancelSchedule('julien');
    expect(a.u.blockReason()).toBeNull();
    a.store.setStatus(t.id, 'succeeded');
    await a.u.tick();
    expect(a.started).toEqual([]);
  });
  it('"now" stops the running tasks (resumable) before updating', async () => {
    const a = await build([rel('v0.3.0')]);
    await a.u.check();
    const t = addTask(a, makeRemote(), { prompt: 'x' });
    a.store.setStatus(t.id, 'running');
    await a.u.start('now', 'julien');
    expect(a.store.getTask(t.id)!.status).toBe('stopped');
    expect(a.started).toEqual(['0.3.0']);
  });
  it('refuses a second update while one runs, and when nothing is available', async () => {
    const a = await build([rel('v0.2.0')]);
    await a.u.check();
    await expect(a.u.start('idle', 'j')).rejects.toThrow(/no newer version/);
    const b = await build([rel('v0.3.0')], { running: true });
    await b.u.check();
    await expect(b.u.start('idle', 'j')).rejects.toThrow(/already running/);
  });
  it('automatic updates: off by default, night only, only when idle, never loop on a failed version', async () => {
    let hour = 12;
    const mk = () => { const d = new Date('2026-11-08T00:30:00'); d.setHours(hour); return d; };
    const a = await build([rel('v0.3.0')], { now: mk });
    await a.u.check();
    await a.u.tick(); expect(a.started).toEqual([]);            // disabled
    a.u.setAuto(true, 'julien');
    await a.u.tick(); expect(a.started).toEqual([]);            // daytime
    hour = 3;
    const t = addTask(a, makeRemote(), { prompt: 'x' });
    a.store.setStatus(t.id, 'running');
    await a.u.tick(); expect(a.started).toEqual([]);            // task running
    a.store.setStatus(t.id, 'succeeded');
    await a.u.tick(); expect(a.started).toEqual(['0.3.0']);    // night + idle
    a.store.setSetting('update_run', JSON.stringify({ by: 'x', from: '0.2.0', to: '0.3.0', at: 'x', audited: true }));
    await a.u.tick(); expect(a.started).toEqual(['0.3.0']);    // not retried
  });
});

describe('update API rights', () => {
  it('only administrators can see or start updates', async () => {
    const env = makeEnv();
    env.ctx.auth.upsertUser({ githubId: 77, login: 'bob' }, 'user'); env.ctx.auth.addAllowed('user', '77', 'bob');
    const sid = env.ctx.auth.createSession(77, 'test');
    const H = { cookie: `${env.cookieName}=${sid}`, 'content-type': 'application/json' };
    for (const [m, u] of [['GET', '/api/update'], ['POST', '/api/update/check'], ['POST', '/api/update/start'], ['DELETE', '/api/update/schedule'], ['PUT', '/api/update/auto']] as const) {
      const r = await env.call(m, u, m === 'GET' ? undefined : {}, H);
      expect(r.status, `${m} ${u}`).toBe(403);
    }
    expect((await env.call('GET', '/api/update')).status).toBe(200);
  });
  it('the installed version is shown in the settings', async () => {
    const env = makeEnv();
    const r = await (await env.call('GET', '/api/settings')).json();
    expect(r.version).toBe('0.2.0');
  });
});
