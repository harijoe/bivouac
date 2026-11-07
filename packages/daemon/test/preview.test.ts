import { describe, expect, it } from 'vitest';
import { addProject, addTask, makeEnv, makeRemote } from './helpers.js';

const HOST = 'login.demo.1-2-3-4.sslip.io';
function setup() {
  const env = makeEnv();
  const t = addTask(env, makeRemote(), { prompt: 'x', name: 'login' });
  env.store.patchTask(t.id, { devPort: 5173 });
  const auth = (host: string, uri = '/', cookie = '') => env.internal.request('/internal/preview-auth', { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'x-forwarded-uri': uri, ...(cookie ? { cookie } : {}) } });
  return { env, t, auth };
}
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

describe('preview access control (forwardAuth)', () => {
  it('denies by default with a clear page, not a 404', async () => {
    const { auth } = setup();
    const r = await auth(HOST);
    expect(r.status).toBe(403);
    const html = await r.text();
    expect(html).toContain('Access denied'); expect(html).toContain('This preview is private');
  });

  it('owner ticket: single use, sets a host-bound cookie, redirects without the secret', async () => {
    const { env, t, auth } = setup();
    const ticket = env.ctx.previews.createTicket(t.id);
    const r = await auth(HOST, `/dashboard?x=1&bv_ticket=${ticket}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`https://${HOST}/dashboard?x=1`);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/^bv_preview=/); expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/Secure/); expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).not.toMatch(/Domain=/i);
    // replaying the ticket fails
    expect((await auth(HOST, `/?bv_ticket=${ticket}`)).status).toBe(403);
    // with the cookie: allowed, and the cookie is stripped from what the app receives
    const ok = await auth(HOST, '/dashboard', `theme=dark; ${cookieOf(r)}; other=1`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cookie')).toBe('theme=dark; other=1');
    const solo = await auth(HOST, '/', cookieOf(r));
    expect(solo.status).toBe(200); expect(solo.headers.get('cookie')).toBe('');
    // the cookie is useless on another host
    const other = await auth('other.demo.1-2-3-4.sslip.io', '/', cookieOf(r));
    expect([403, 404]).toContain(other.status);
  });

  it('tickets expire after 60 seconds and are bound to their task', async () => {
    const { env, t, auth } = setup();
    const t2 = addTask(env, makeRemote(), { prompt: 'y', name: 'other' });
    const ticket = env.ctx.previews.createTicket(t.id);
    expect((await auth('other.demo.1-2-3-4.sslip.io', `/?bv_ticket=${ticket}`)).status).toBe(403);
    expect(t2.id).not.toBe(t.id);
    const old = env.ctx.previews.createTicket(t.id);
    env.store.db.prepare('UPDATE preview_tickets SET expires_at = expires_at - 120').run();
    expect((await auth(HOST, `/?bv_ticket=${old}`)).status).toBe(403);
  });

  it('share links: grant access to that preview only, expire, and can be revoked', async () => {
    const { env, t, auth } = setup();
    const t2 = addTask(env, makeRemote(), { prompt: 'y', name: 'other' });
    env.store.patchTask(t2.id, { devPort: 3000 });
    const s = env.ctx.previews.createShare(t.id, '1h');
    const entry = await auth(HOST, `/?bv_share=${s.token}`);
    expect(entry.status).toBe(302); expect(entry.headers.get('location')).toBe(`https://${HOST}/`);
    const cookie = cookieOf(entry);
    expect((await auth(HOST, '/page', cookie)).status).toBe(200);
    // the same link does not open another task's preview
    expect((await auth('other.demo.1-2-3-4.sslip.io', `/?bv_share=${s.token}`)).status).toBe(403);
    expect((await auth('other.demo.1-2-3-4.sslip.io', '/', cookie)).status).toBe(403);
    // revoke: both the link and the cookie stop working immediately
    env.ctx.previews.revokeShare(s.id);
    expect((await auth(HOST, '/page', cookie)).status).toBe(403);
    expect((await auth(HOST, `/?bv_share=${s.token}`)).status).toBe(403);
    // expiry
    const s2 = env.ctx.previews.createShare(t.id, '1h');
    const c2 = cookieOf(await auth(HOST, `/?bv_share=${s2.token}`));
    env.store.db.prepare('UPDATE share_links SET expires_at = expires_at - 7200 WHERE id=?').run(s2.id);
    expect((await auth(HOST, '/', c2)).status).toBe(403);
    // a "never" link has no expiry
    expect(env.ctx.previews.createShare(t.id, 'never').expiresAt).toBeNull();
  });

  it('tampered cookies and the dashboard cookie are not accepted', async () => {
    const { env, t, auth } = setup();
    const ticket = env.ctx.previews.createTicket(t.id);
    const c = cookieOf(await auth(HOST, `/?bv_ticket=${ticket}`));
    expect((await auth(HOST, '/', c.slice(0, -3) + 'abc')).status).toBe(403);
    expect((await auth(HOST, '/', `${env.cookieName}=${env.sid}`)).status).toBe(403);
  });

  it('renaming moves the preview host and invalidates share links', async () => {
    const { env, t, auth } = setup();
    const s = env.ctx.previews.createShare(t.id, '24h');
    const cookie = cookieOf(await auth(HOST, `/?bv_share=${s.token}`));
    const r = await env.call('POST', `/api/tasks/${t.id}/rename`, { name: 'signup' });
    expect(r.status).toBe(200);
    const renamed: any = await r.json();
    expect(renamed.previewUrl).toBe('https://signup.demo.1-2-3-4.sslip.io');
    // new route immediately in the Traefik config, old one gone
    const conf: any = await (await env.internal.request('/internal/traefik')).json();
    expect(conf.http.routers[`bivouac-t${t.id}`].rule).toBe('Host(`signup.demo.1-2-3-4.sslip.io`)');
    expect(JSON.stringify(conf)).not.toContain('login.demo');
    expect((await auth(HOST, '/', cookie)).status).toBe(404);
    expect((await auth('signup.demo.1-2-3-4.sslip.io', `/?bv_share=${s.token}`)).status).toBe(403);
    // the branch is unchanged
    expect(env.store.getTask(t.id)!.branch).toBe(t.branch);
  });

  it('unknown preview hosts say so', async () => {
    const { auth } = setup();
    const r = await auth('ghost.demo.1-2-3-4.sslip.io');
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('does not exist');
  });

  it('the dashboard route requires no forwardAuth, task routes do', async () => {
    const { env, t } = setup();
    const conf: any = await (await env.internal.request('/internal/traefik')).json();
    expect(conf.http.routers['bivouac-web'].middlewares).toBeUndefined();
    expect(conf.http.routers[`bivouac-t${t.id}`].middlewares).toEqual(['bivouac-preview-auth']);
  });
});

describe('task names', () => {
  it('are unique per project, validated, and explicit about conflicts', async () => {
    const env = makeEnv();
    addProject(env, makeRemote());
    const mk = (name: string) => env.svc.createTask({ project: 'demo', name, prompt: 'p' }, { kind: 'user', label: 'julien' });
    await mk('one');
    await expect(mk('one')).rejects.toThrow(/already used in project "demo"/);
    for (const bad of ['', 'Upper', 'has space', '-dash', 'dash-', 'x'.repeat(41), 'under_score', 'a.b']) await expect(mk(bad)).rejects.toThrow(/name/i);
    await expect(mk('a'.repeat(40))).resolves.toBeTruthy();
    await expect(mk('x')).resolves.toBeTruthy();
    // a different project may reuse the name
    env.store.createProject({ name: 'other', repoUrl: makeRemote(), defaultBranch: 'main', config: { dev: { command: 'sleep 1000', port: 1 } } });
    await expect(env.svc.createTask({ project: 'other', name: 'one', prompt: 'p' }, { kind: 'user', label: 'j' })).resolves.toBeTruthy();
    // renaming onto an existing name is refused too
    const t = env.store.getTaskByName(env.store.getProjectByName('demo')!.id, 'x')!;
    const r = await env.call('POST', `/api/tasks/${t.id}/rename`, { name: 'one' });
    expect(r.status).toBe(409);
  });
});
