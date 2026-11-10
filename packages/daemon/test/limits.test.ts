import { describe, expect, it } from 'vitest';
import { addTask, makeEnv, makeRemote } from './helpers.js';
import { connect } from './mcp-client.js';

const OK = 'grep -q ok fake-output.txt';
const text = (r: any) => r.content[0].text as string;

async function run(env: ReturnType<typeof makeEnv>, id: number) {
  env.mgr.enqueue(id);
  await env.mgr.settled(id);
  return env.store.getTask(id)!;
}

describe('changing the limits of an existing task', () => {
  it('a task that stopped on its budget cannot resume until the limit is raised, and then does', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=fail-then-succeed FAKE_COST=2', success: `${OK} || exit 3`, maxCost: 3, maxIterations: 10 });
    const r = await run(env, t.id);
    expect(r.status).toBe('budget_exceeded');

    // plain resume: refused with the way out
    const plain = await env.call('POST', `/api/tasks/${t.id}/resume`, {});
    expect(plain.status).toBe(409);
    expect((await plain.json()).error).toMatch(/used its whole budget.*max_cost_usd.*update_task/s);
    // a raise that is still below what was spent is refused too
    expect((await env.call('POST', `/api/tasks/${t.id}/resume`, { maxCostUsd: 1 })).status).toBe(409);
    expect(env.store.getTask(t.id)!.maxCostUsd).toBe(3);

    const ok = await env.call('POST', `/api/tasks/${t.id}/resume`, { maxCostUsd: 30 });
    expect(ok.status).toBe(200);
    await env.mgr.settled(t.id);
    const after = env.store.getTask(t.id)!;
    expect(after.maxCostUsd).toBe(30);
    expect(after.status).toBe('succeeded');
    const ev = env.store.listEvents(t.id).find((e) => e.data?.subtype === 'limits_changed' && e.data.by !== 'bivouac');
    expect(ev?.data.changes).toEqual([{ field: 'maxCostUsd', from: 3, to: 30 }]);
    expect(ev?.data.message).toMatch(/Budget: \$3\.00 → \$30\.00\. Applies from the next attempt/);
  });

  it('max_iterations: a plain resume extends the allowance, an explicit value is kept', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=always-fail', success: OK, maxIterations: 2, config: { budget: { max_iterations: 4 } } });
    expect((await run(env, t.id)).status).toBe('max_iterations');
    await env.svc.resumeTask(env.store.getTask(t.id)!, { kind: 'user', label: 't' });
    await env.mgr.settled(t.id);
    expect(env.store.getTask(t.id)!.maxIterations).toBe(6); // 2 made + 4 configured
    const t2 = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=always-fail', success: OK, maxIterations: 2, name: 'b' });
    await run(env, t2.id);
    await env.svc.resumeTask(env.store.getTask(t2.id)!, { kind: 'user', label: 't' }, undefined, { maxIterations: 3 });
    await env.mgr.settled(t2.id);
    expect(env.store.getTask(t2.id)).toMatchObject({ maxIterations: 3, iteration: 3, status: 'max_iterations' });
  });

  it('the success command and the limits are read again at each attempt', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=always-fail', success: 'exit 9', maxIterations: 1 });
    expect((await run(env, t.id)).status).toBe('max_iterations');
    const r = await env.call('PATCH', `/api/tasks/${t.id}`, { successCommand: OK, maxIterations: 3 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ successCommand: OK, maxIterations: 3 });
    // always-fail never writes `ok`, so the new command still fails, but it is the new one that ran
    await env.svc.resumeTask(env.store.getTask(t.id)!, { kind: 'user', label: 't' });
    await env.mgr.settled(t.id);
    const checks = env.store.listEvents(t.id).filter((e) => e.kind === 'check').map((e) => e.data.command);
    expect(checks[0]).toBe('exit 9');
    expect(checks.at(-1)).toBe(OK);
  });

  it('validates the values with clear messages', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x' });
    const bad = async (body: object) => { const r = await env.call('PATCH', `/api/tasks/${t.id}`, body); expect(r.status).toBe(400); return (await r.json()).error as string; };
    expect(await bad({ maxCostUsd: -2 })).toMatch(/positive number of dollars/);
    expect(await bad({ maxIterations: 2.5 })).toMatch(/whole number/);
    expect(await bad({ successCommand: '   ' })).toMatch(/cannot be empty/);
    expect(await bad({})).toMatch(/Nothing to change/);
  });

  it('is available through MCP: update_task, and resume_task with a new budget', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=fail-then-succeed FAKE_COST=2', success: `${OK} || exit 3`, maxCost: 3, maxIterations: 10 });
    await run(env, t.id);
    const c = await connect(env);
    const upd = await c.callTool({ name: 'update_task', arguments: { project: 'demo', task: t.name, max_cost_usd: 12, success_command: `${OK} || exit 4` } }) as any;
    expect(JSON.parse(text(upd))).toMatchObject({ maxCostUsd: 12, successCommand: `${OK} || exit 4` });
    const res = await c.callTool({ name: 'resume_task', arguments: { project: 'demo', task: t.name, max_cost_usd: 15 } }) as any;
    expect(res.isError).toBeFalsy();
    await env.mgr.settled(t.id);
    expect(env.store.getTask(t.id)!.maxCostUsd).toBe(15);
    // exhausted again with an unchanged budget: the message says what to do
    env.store.setUsage(t.id, { ...env.store.getTask(t.id)!.usage, costUsd: 15 });
    env.store.setStatus(t.id, 'budget_exceeded');
    const refused = await c.callTool({ name: 'resume_task', arguments: { project: 'demo', task: t.name } }) as any;
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/whole budget: \$15\.00/);
    const get = JSON.parse(text(await c.callTool({ name: 'get_task', arguments: { project: 'demo', task: t.name } }) as any));
    expect(get).toMatchObject({ maxCostUsd: 15, successCommand: expect.any(String) });
    await c.close();
  });
});
