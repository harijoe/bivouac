import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addTask, makeEnv, makeRemote, repoOf } from './helpers.js';
import { buildTraefikConfig } from '../src/routes.js';

const DOM = '1-2-3-4.sslip.io';
function setup() {
  const env = makeEnv();
  const t = addTask(env, makeRemote(), { prompt: 'x', name: 'login' });
  env.store.patchTask(t.id, { devPort: 5173 });
  const auth = (host: string, uri = '/', cookie = '') => env.internal.request('/internal/preview-auth', { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'x-forwarded-uri': uri, ...(cookie ? { cookie } : {}) } });
  return { env, t, auth };
}
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const admin = { kind: 'user' as const, label: 'julien' };

describe('preview health reported by the supervisor', () => {
  function health(env: ReturnType<typeof makeEnv>, taskId: number, h: object) {
    const ws = env.sandboxes.get(taskId)!.ws;
    mkdirSync(path.join(ws, '.bivouac'), { recursive: true });
    writeFileSync(path.join(ws, '.bivouac', 'health.json'), JSON.stringify({ since: new Date().toISOString(), lastHealthyAt: null, restarts: 0, cause: null, nextRetryAt: null, updatedAt: new Date().toISOString(), ...h }));
  }
  it('records the stop, the restarts and the recovery in the history and tells the agent', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it', success: 'grep -q ok fake-output.txt' });
    env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
    const w = env.svc.pwatch;
    const get = () => env.store.getTask(t.id)!;
    const subtypes = () => env.store.listEvents(t.id).filter((e) => e.kind === 'system' && String(e.data.subtype).startsWith('preview_')).map((e) => e.data.subtype);

    health(env, t.id, { state: 'healthy', lastHealthyAt: new Date().toISOString() });
    await w.check(get());
    expect(get().preview?.state).toBe('healthy');
    expect(subtypes()).toEqual([]);

    health(env, t.id, { state: 'unhealthy', restarts: 1, cause: 'the dev server exited (code 1); last output: Error: EADDRINUSE', nextRetryAt: new Date(Date.now() + 2000).toISOString() });
    await w.check(get());
    expect(get().preview).toMatchObject({ state: 'unhealthy', restarts: 1 });
    expect(subtypes()).toEqual(['preview_down']);
    // same state again (heartbeat): nothing new
    await w.check(get());
    expect(subtypes()).toEqual(['preview_down']);

    health(env, t.id, { state: 'unhealthy', restarts: 2, cause: 'the dev server exited (code 1)' });
    await w.check(get());
    expect(subtypes()).toEqual(['preview_down', 'preview_restarting']);

    health(env, t.id, { state: 'down', restarts: 8, cause: 'the dev server exited (code 1)' });
    await w.check(get());
    expect(get().preview?.state).toBe('down');
    expect(subtypes().at(-1)).toBe('preview_gave_up');

    health(env, t.id, { state: 'healthy', restarts: 8, cause: 'the dev server exited (code 1)', since: new Date().toISOString() });
    await w.check(get());
    expect(subtypes().at(-1)).toBe('preview_recovered');
    expect(get().preview?.cause).toMatch(/exited/); // the last cause stays visible

    // the agent is told at its next session, once
    await env.mgr.resume(t.id, 'continue');
    await env.mgr.settled(t.id);
    const prompts = readFileSync(path.join(repoOf(env, t), '.bivouac', 'fake-prompts.log'), 'utf8');
    expect(prompts).toMatch(/Notes from bivouac about this task/);
    expect(prompts).toMatch(/preview of this task is down/);
    expect(prompts).toMatch(/gave up restarting/);
    expect(env.store.takeNotices(t.id)).toEqual([]);
    expect(get().preview).toBeNull(); // a new session starts from a clean slate
    await w.check(get());
    expect(env.svc.summary(get()).preview).toMatchObject({ state: 'healthy', restarts: 8 });
  });

  it('shows a stopped task as such and asks the supervisor to restart on request', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it' });
    env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
    await env.svc.restartPreview(env.store.getTask(t.id)!, admin);
    expect(readFileSync(path.join(env.sandboxes.get(t.id)!.ws, '.bivouac', 'restart.req'), 'utf8')).toMatch(/\d+/);
    expect(env.store.listEvents(t.id).some((e) => e.data.subtype === 'preview_restart_requested')).toBe(true);
    await env.mgr.stop(t.id);
    env.store.setStatus(t.id, 'stopped');
    await env.svc.pwatch.check(env.store.getTask(t.id)!);
    expect(env.store.getTask(t.id)!.preview?.state).toBe('stopped');
  });

  it('keeps the same host and route after a stop and a resume', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it', name: 'stable' });
    env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
    const before = env.store.getTask(t.id)!;
    await env.mgr.stop(t.id);
    env.mgr.recover();
    await env.mgr.resume(t.id, 'again'); await env.mgr.settled(t.id);
    const after = env.store.getTask(t.id)!;
    expect(after.previewUrl).toBe(before.previewUrl);
    expect(after.previewUrl).toBe(`https://stable.demo.${DOM}`);
    const conf = buildTraefikConfig({ ...env.cfg, certResolver: null }, env.store.routeTasks());
    expect(conf.http.routers[`bivouac-t${t.id}`].rule).toContain(`stable.demo.${DOM}`);
    expect(repoOf(env, after)).toBeTruthy();
  });
});

describe('project alias', () => {
  it('is validated: reserved words, project names, uniqueness', () => {
    const { env, t } = setup();
    const p = env.store.getProject(t.projectId)!;
    expect(() => env.svc.setAlias(p.id, { alias: 'Bad Name' }, admin)).toThrow(/not a valid alias/);
    expect(() => env.svc.setAlias(p.id, { alias: 'www' }, admin)).toThrow(/reserved/);
    expect(() => env.svc.setAlias(p.id, { alias: 'demo' }, admin)).toThrow(/name of a project/);
    expect(() => env.svc.setAlias(p.id, { task: 'login' }, admin)).toThrow(/no alias yet/);
    env.svc.setAlias(p.id, { alias: 'app' }, admin);
    const other = env.store.createProject({ name: 'other', repoUrl: 'x', defaultBranch: 'main' });
    expect(() => env.svc.setAlias(other.id, { alias: 'app' }, admin)).toThrow(/already used/);
    expect(() => env.svc.setAlias(p.id, { publicPaths: ['/'] }, admin)).toThrow(/not an allowed public path/);
    expect(() => env.svc.setAlias(p.id, { publicPaths: ['/a/../b'] }, admin)).toThrow(/not an allowed public path/);
  });

  it('points at a task: routes, URLs, access control, public paths, and moves to another task', async () => {
    const { env, t, auth } = setup();
    const t2 = addTask(env, makeRemote(), { prompt: 'y', name: 'checkout' });
    env.store.patchTask(t2.id, { devPort: 5173 });
    const p = env.store.getProject(t.projectId)!;
    env.svc.setAlias(p.id, { alias: 'app', publicPaths: ['/api/webhooks/', '/auth/callback'] }, admin);
    expect(env.store.getTask(t.id)!.aliasUrl).toBeNull(); // defined, not assigned yet
    env.svc.setAlias(p.id, { task: 'login' }, admin);
    const login = env.store.getTask(t.id)!;
    expect(login.aliasUrl).toBe(`https://app.${DOM}`);
    expect(env.store.getTask(t2.id)!.aliasUrl).toBeNull();
    // Traefik routes the alias host to the same container, with the same access check
    const conf = buildTraefikConfig({ ...env.cfg, certResolver: null }, env.store.routeTasks());
    expect(conf.http.routers[`bivouac-t${t.id}-alias`]).toMatchObject({ rule: `Host(\`app.${DOM}\`)`, service: `bivouac-t${t.id}`, middlewares: ['bivouac-preview-auth'] });
    expect(conf.http.routers[`bivouac-t${t2.id}-alias`]).toBeUndefined();
    // private by default, owner ticket works on the alias host
    const ALIAS = `app.${DOM}`;
    expect((await auth(ALIAS, '/')).status).toBe(403);
    const url = new URL(env.svc.ownerPreviewUrl(login, undefined, true));
    expect(url.host).toBe(ALIAS);
    const r = await auth(ALIAS, url.pathname + url.search);
    expect(r.status).toBe(302);
    expect((await auth(ALIAS, '/dashboard', cookieOf(r))).status).toBe(200);
    // webhook and OAuth callback paths are open (and no cookie reaches the app), everything else stays private
    const hook = await auth(ALIAS, '/api/webhooks/stripe', 'a=1');
    expect(hook.status).toBe(200); expect(hook.headers.get('cookie')).toBe('a=1');
    expect((await auth(ALIAS, '/auth/callback?code=x')).status).toBe(200);
    expect((await auth(ALIAS, '/auth/callback/evil')).status).toBe(403);
    expect((await auth(ALIAS, '/api/webhooks')).status).toBe(403);
    expect((await auth(ALIAS, '/api/webhooks/../admin')).status).toBe(403);
    // the task URL does not get those open paths
    expect((await auth(`login.demo.${DOM}`, '/api/webhooks/stripe')).status).toBe(403);
    // moving the alias: the old task loses it, the history says so
    env.svc.setAlias(p.id, { task: 'checkout' }, admin);
    expect(env.store.getTask(t.id)!.aliasUrl).toBeNull();
    expect(env.store.getTask(t2.id)!.aliasUrl).toBe(`https://app.${DOM}`);
    expect(env.store.listEvents(t.id).some((e) => e.data.subtype === 'alias_released')).toBe(true);
    expect(env.store.listEvents(t2.id).some((e) => e.data.subtype === 'alias_assigned')).toBe(true);
    expect((await auth(ALIAS, '/api/webhooks/stripe')).status).toBe(200);
    // the old cookie was for the task; it still passes because the host is the same (the alias is one host)
    // detaching or deleting the task leaves a clear "not found"
    env.svc.setAlias(p.id, { task: null }, admin);
    expect((await auth(ALIAS, '/api/webhooks/stripe')).status).toBe(404);
  });

  it('is served by the API: administrators define it, any user moves it', async () => {
    const { env, t } = setup();
    const p = env.store.getProject(t.projectId)!;
    expect((await env.call('PUT', `/api/projects/${p.id}/alias`, { alias: 'app' })).status).toBe(200);
    const moved = await env.call('PUT', `/api/projects/${p.id}/alias`, { task: 'login' });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as any).aliasTaskId).toBe(t.id);
    const bad = await env.call('PUT', `/api/projects/${p.id}/alias`, { alias: 'www' });
    expect(bad.status).toBe(400);
    const task: any = await (await env.call('GET', `/api/tasks/${t.id}`)).json();
    expect(task.aliasUrl).toBe(`https://app.${DOM}`);
    expect(task.ports[0].aliasUrl).toBe(`https://app.${DOM}`);
  });
});

describe('share links', () => {
  it('lists active links, expires them and explains it to the visitor', async () => {
    const { env, t, auth } = setup();
    const task = env.store.getTask(t.id)!;
    const a = env.svc.createShareLink(task, '1h', admin);
    const b = env.svc.createShareLink(task, '7d', admin);
    const c = env.svc.createShareLink(task, 'never', admin);
    expect(a.expiresAt! - Math.floor(Date.now() / 1000)).toBeGreaterThan(3590);
    expect(b.expiresAt! - Math.floor(Date.now() / 1000)).toBeGreaterThan(7 * 86400 - 10);
    expect(c.expiresAt).toBeNull();
    expect(env.ctx.previews.listShares(t.id).filter((s) => s.active)).toHaveLength(3);
    const tokenA = new URL(a.url).searchParams.get('bv_share')!;
    const first = await auth(`login.demo.${DOM}`, `/?bv_share=${tokenA}`);
    expect(first.status).toBe(302);
    const cookie = cookieOf(first);
    expect((await auth(`login.demo.${DOM}`, '/x', cookie)).status).toBe(200);
    // the hour passes
    env.store.db.prepare('UPDATE share_links SET expires_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 5, a.id);
    expect(env.ctx.previews.listShares(t.id).filter((s) => s.active)).toHaveLength(2);
    const late = await auth(`login.demo.${DOM}`, `/?bv_share=${tokenA}`);
    expect(late.status).toBe(403);
    const page = await late.text();
    expect(page).toContain('This link has expired'); expect(page).toContain('Ask the person who sent you the link');
    // a visitor who already had the cookie sees the same page
    const withCookie = await auth(`login.demo.${DOM}`, '/x', cookie);
    expect(withCookie.status).toBe(403);
    expect(await withCookie.text()).toContain('This link has expired');
    // revoked is told apart from expired, and effective at once
    const tokenB = new URL(b.url).searchParams.get('bv_share')!;
    const ok = await auth(`login.demo.${DOM}`, `/?bv_share=${tokenB}`);
    env.svc.revokeShareLink(task, b.id, admin);
    const gone = await auth(`login.demo.${DOM}`, '/y', cookieOf(ok));
    expect(gone.status).toBe(403);
    expect(await gone.text()).toContain('This link was revoked');
    await expect(env.svc.describeTask(task)).resolves.toMatchObject({ shareLinks: [expect.objectContaining({ id: c.id })] });
  });
});
