import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server.js';
import { makeEnv, makeRemote } from './helpers.js';

const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
function setup() {
  const env = makeEnv();
  const app = createApp(env.cfg, env.store, env.mgr);
  const call = (method: string, url: string, body?: unknown, headers = H) => app.request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { env, call, app };
}
describe('api', () => {
  it('requires auth except health', async () => {
    const { call } = setup();
    expect((await call('GET', '/api/health', undefined, {} as any)).status).toBe(200);
    expect((await call('GET', '/api/projects', undefined, {} as any)).status).toBe(401);
    expect((await call('GET', '/api/projects', undefined, { authorization: 'Bearer nope' } as any)).status).toBe(401);
    expect((await call('GET', '/api/projects')).status).toBe(200);
  });
  it('login sets an http-only cookie', async () => {
    const { app } = setup();
    const r = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ token: 'tok' }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/bivouac_token=tok.*HttpOnly/i);
    const ok = await app.request('/api/projects', { headers: { cookie: 'bivouac_token=tok' } });
    expect(ok.status).toBe(200);
  });
  it('project + task lifecycle through the API', async () => {
    const { call, env } = setup();
    const remote = makeRemote({ 'README.md': 'x', 'bivouac.yml': 'success: grep -q ok fake-output.txt\ndev:\n  command: sleep 1000\n  port: 3001\nbudget:\n  max_iterations: 4\n' });
    const pr = await call('POST', '/api/projects', { repoUrl: remote, name: 'Demo App', githubToken: 'ghp_x' });
    expect(pr.status).toBe(201);
    const project: any = await pr.json();
    expect(project.name).toBe('demo-app'); expect(project.defaultBranch).toBe('main'); expect(project.githubToken).toBeUndefined();
    expect((await call('POST', '/api/projects', { repoUrl: remote, name: 'Demo App' })).status).toBe(409);
    expect((await call('POST', '/api/projects', { repoUrl: '/nonexistent/repo' })).status).toBe(400);
    const tr = await call('POST', `/api/projects/${project.id}/tasks`, { prompt: 'make it work FAKE_SCENARIO=fail-then-succeed' });
    expect(tr.status).toBe(201);
    const task: any = await tr.json();
    expect(task.successCommand).toBe('grep -q ok fake-output.txt');
    expect(task.maxIterations).toBe(4);
    expect(task.branch).toMatch(/^agent\/t-1-make-it-work/);
    expect(task.previewUrl).toBe(`http://t-1.demo-app.1-2-3-4.sslip.io`);
    await env.mgr.settled(task.id);
    const done: any = await (await call('GET', `/api/tasks/${task.id}`)).json();
    expect(done.status).toBe('succeeded'); expect(done.iteration).toBe(2);
    const ev: any[] = await (await call('GET', `/api/tasks/${task.id}/events`)).json();
    expect(ev.length).toBeGreaterThan(5);
    const totals: any = await (await call('GET', '/api/totals')).json();
    expect(totals.costUsd).toBeCloseTo(0.02);
    const dl = await call('DELETE', `/api/tasks/${task.id}`);
    expect(dl.status).toBe(409);
    expect(((await dl.json()) as any).code).toBe('UNPUSHED');
    expect((await call('DELETE', `/api/tasks/${task.id}?force=1`)).status).toBe(200);
    expect((await call('GET', `/api/tasks/${task.id}`)).status).toBe(404);
  });
  it('streams events over SSE', async () => {
    const { call, env, app } = setup();
    const remote = makeRemote();
    const project: any = await (await call('POST', '/api/projects', { repoUrl: remote })).json();
    const task: any = await (await call('POST', `/api/projects/${project.id}/tasks`, { prompt: 'hi' })).json();
    await env.mgr.settled(task.id);
    const res = await app.request(`/api/stream?task=${task.id}`, { headers: H });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = '';
    const dec = new TextDecoder();
    while (!text.includes('event: ready')) { const { value } = await reader.read(); text += dec.decode(value); }
    await reader.cancel();
    expect(text).toContain('event: event');
    expect(text).toContain('"kind":"result"');
  });
});
