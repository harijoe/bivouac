import { describe, expect, it } from 'vitest';
import { addProject, makeEnv, makeRemote } from './helpers.js';
import { connect } from './mcp-client.js';

const norm = (t: any) => ({
  status: t.status, project: t.project ?? t.projectName, title: t.title, maxIterations: t.maxIterations, successCommand: t.successCommand, baseBranch: t.baseBranch,
  maxCostUsd: t.maxCostUsd, maxTokens: t.maxTokens,
});

describe('creating a task from the dashboard', () => {
  it('gives the same result through REST and through the MCP tool (same service)', async () => {
    const env = makeEnv();
    addProject(env, makeRemote({ 'README.md': 'x', 'bivouac.yml': 'success: grep -q ok fake-output.txt\ndev:\n  command: sleep 1000\n  port: 3001\n' }));
    const c = await connect(env);
    const args = { prompt: '# Add a login page\n\nWith **email**', success_command: 'grep -q ok fake-output.txt', max_iterations: 3, max_cost_usd: 2 };
    const viaMcp = JSON.parse(((await c.callTool({ name: 'create_task', arguments: { project: 'demo', name: 'via-mcp', ...args } })) as any).content[0].text);
    const r = await env.call('POST', '/api/tasks', { project: 'demo', name: 'via-rest', prompt: args.prompt, successCommand: args.success_command, maxIterations: 3, maxCostUsd: 2 });
    expect(r.status).toBe(201);
    const viaRest = await r.json();
    for (const n of ['via-mcp', 'via-rest']) { const id = env.store.getProjectByName('demo') && env.store.listTasks().find((t) => t.name === n)!.id; await env.mgr.settled(id); }
    expect(norm(viaRest)).toEqual(norm({ ...viaMcp, successCommand: args.success_command, baseBranch: 'main', maxTokens: null }));
    expect(viaRest.title).toBe('Add a login page'); // no Markdown in the title
    expect(viaRest).toMatchObject({ name: 'via-rest', branch: expect.stringContaining('via-rest'), dashboardUrl: expect.stringContaining('/projects/demo/via-rest') });
    await c.close();
  });

  it('derives a free name from the prompt, and the same errors as the MCP tool', async () => {
    const env = makeEnv();
    addProject(env, makeRemote());
    const a = await (await env.call('POST', '/api/tasks', { project: 'demo', prompt: 'Fix the login bug!', maxIterations: 1 })).json();
    expect(a.name).toBe('fix-the-login-bug');
    const b = await (await env.call('POST', '/api/tasks', { project: 'demo', prompt: 'Fix the login bug!', maxIterations: 1 })).json();
    expect(b.name).toBe('fix-the-login-bug-2');
    const bad = await env.call('POST', '/api/tasks', { project: 'demo', name: 'Not Valid', prompt: 'x' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/lowercase letters/);
    expect((await env.call('POST', '/api/tasks', { project: 'demo', name: 'ok', prompt: '  ' })).status).toBe(400);
    expect((await env.call('POST', '/api/tasks', { project: 'nope', name: 'ok', prompt: 'x' })).status).toBe(404);
    expect((await env.call('POST', '/api/tasks', { name: 'ok', prompt: 'x' })).status).toBe(400);
    const same1 = await env.call('POST', '/api/tasks', { project: 'demo', name: 'idem', prompt: 'x', idempotencyKey: 'k' });
    const same2 = await env.call('POST', '/api/tasks', { project: 'demo', name: 'idem2', prompt: 'x', idempotencyKey: 'k' });
    expect(same1.status).toBe(201); expect(same2.status).toBe(200);
    expect((await same2.json()).name).toBe('idem');
    for (const t of env.store.listTasks()) await env.mgr.settled(t.id);
  });
});

describe('project overview data for the dashboard', () => {
  it('stats per project, open agent pull requests from GitHub (cached), mcpConnected in the session', async () => {
    const calls: string[] = [];
    const github = (async (url: any) => {
      calls.push(String(url));
      if (String(url).includes('/pulls?state=open')) return new Response(JSON.stringify([
        { number: 7, html_url: 'https://github.com/o/r/pull/7', title: 'Add login', head: { ref: 'agent/t-1-login' } },
        { number: 8, html_url: 'https://github.com/o/r/pull/8', title: 'Human PR', head: { ref: 'feature/x' } },
      ]), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const env = makeEnv({}, { github });
    const remote = makeRemote();
    const p = env.store.createProject({ name: 'demo', repoUrl: remote, defaultBranch: 'main', githubRepo: 'o/r', githubToken: 'ghp_x'.padEnd(40, 'x') });
    const t = env.store.createTask({ projectId: p.id, name: 'a', title: 'A', prompt: 'x', successCommand: 'true', baseBranch: 'main', maxIterations: 1, maxCostUsd: 1 }, (id) => `agent/t-${id}-a`);
    env.store.setStatus(t.id, 'failed', 'boom');
    const list = await (await env.call('GET', '/api/projects')).json();
    expect(list[0].stats).toMatchObject({ running: 0, failed: 1, withPr: 0 });
    expect(list[0].stats.lastActivityAt).toBeTruthy();
    const prs = await (await env.call('GET', `/api/projects/${p.id}/pulls`)).json();
    expect(prs.prs).toEqual([{ number: 7, url: 'https://github.com/o/r/pull/7', title: 'Add login', branch: 'agent/t-1-login' }]);
    await env.call('GET', `/api/projects/${p.id}/pulls`);
    expect(calls.filter((c) => c.includes('/pulls?state=open'))).toHaveLength(1); // cached for a minute
    expect((await env.call('GET', '/api/projects/999/pulls')).status).toBe(404);
    expect((await (await env.call('GET', '/api/session')).json()).mcpConnected).toBe(false);
    await (await connect(env)).close();
    expect((await (await env.call('GET', '/api/session')).json()).mcpConnected).toBe(true);
  });
});
