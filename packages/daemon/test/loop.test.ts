import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { addTask, makeEnv, makeRemote, repoOf, taskDirOf } from './helpers.js';

const OK = 'grep -q ok fake-output.txt';

async function run(env: ReturnType<typeof makeEnv>, id: number) {
  env.mgr.enqueue(id);
  await env.mgr.settled(id);
  return env.store.getTask(id)!;
}

describe('success loop', () => {
  it('succeeds on first iteration', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it', success: OK });
    const r = await run(env, t.id);
    expect(r.status).toBe('succeeded');
    expect(r.iteration).toBe(1);
    expect(r.sessionId).toBeTruthy();
    expect(r.usage.costUsd).toBeCloseTo(0.01);
    expect(r.usage.outputTokens).toBe(75);
    const kinds = env.store.listEvents(t.id).map((e) => e.kind);
    expect(kinds).toContain('tool_use'); expect(kinds).toContain('check'); expect(kinds).toContain('result');
    // branch created from base and commit made by the fake agent
    const repo = repoOf(env, r);
    expect(readFileSync(path.join(repo, 'fake-output.txt'), 'utf8')).toBe('ok\n');
  });

  it('failed check relaunches the agent with --resume and the failure output', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it FAKE_SCENARIO=fail-then-succeed', success: `${OK} || { echo "ASSERTION: expected ok"; exit 3; }` });
    const r = await run(env, t.id);
    expect(r.status).toBe('succeeded');
    expect(r.iteration).toBe(2);
    expect(r.usage.costUsd).toBeCloseTo(0.02);
    const events = env.store.listEvents(t.id);
    const checks = events.filter((e) => e.kind === 'check');
    expect(checks.map((c) => c.data.exitCode)).toEqual([3, 0]);
    const texts = events.filter((e) => e.kind === 'assistant_text').map((e) => e.data.text as string);
    expect(texts.some((x) => x.includes('(resumed)') && x.includes('The success command'))).toBe(true);
    expect(texts.some((x) => x.includes('Run #2'))).toBe(true);
  });

  it('stops with max_iterations', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=always-fail', success: OK, maxIterations: 3 });
    const r = await run(env, t.id);
    expect(r.status).toBe('max_iterations');
    expect(r.iteration).toBe(3);
  });

  it('goes to blocked when the agent declares it cannot continue, and does not retry', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=blocked', success: OK, maxIterations: 5 });
    const r = await run(env, t.id);
    expect(r.status).toBe('blocked');
    expect(r.iteration).toBe(1);
    expect(r.error).toMatch(/Node >= 26/);
    expect(env.store.listEvents(t.id).some((e) => e.data.subtype === 'blocked')).toBe(true);
    // resuming with a message restarts it (and the declaration is consumed)
    await env.mgr.resume(t.id, 'use node 26 from runtime');
    await env.mgr.settled(t.id);
    expect(env.store.getTask(t.id)!.iteration).toBe(2);
  });

  it('goes to stuck when two checks fail with the same output and no code change in between', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=stuck', success: OK, maxIterations: 8 });
    const r = await run(env, t.id);
    expect(r.status).toBe('stuck');
    expect(r.iteration).toBe(2);
    expect(r.error).toMatch(/twice in a row/);
  });

  it('keeps retrying when the output is the same but the code changed', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=always-fail', success: OK, maxIterations: 3 });
    expect((await run(env, t.id)).status).toBe('max_iterations');
  });

  it('stops with budget_exceeded (cost, enforced via --max-budget-usd)', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=always-fail FAKE_COST=2', success: OK, maxCost: 3, maxIterations: 10 });
    const r = await run(env, t.id);
    expect(r.status).toBe('budget_exceeded');
    expect(r.usage.costUsd).toBeLessThanOrEqual(4.01);
    expect(r.iteration).toBeLessThanOrEqual(3);
  });

  it('stops with budget_exceeded (tokens)', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=always-fail', success: OK, maxTokens: 150, maxIterations: 10 });
    const r = await run(env, t.id);
    expect(r.status).toBe('budget_exceeded');
  });

  it('fails when the setup command fails', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x', config: { setup: 'exit 7' } });
    const r = await run(env, t.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/setup command failed/);
  });

  it('fails cleanly when the agent crashes', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_CRASH=1' });
    const r = await run(env, t.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/without a result/);
  });

  it('stop aborts a running agent, and resume + instruction continue it', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_DELAY=400', success: OK });
    env.mgr.enqueue(t.id);
    await new Promise((r) => setTimeout(r, 900));
    expect(env.store.getTask(t.id)!.status).toBe('running');
    await env.mgr.stop(t.id);
    expect(env.store.getTask(t.id)!.status).toBe('stopped');
    const sess = env.store.getTask(t.id)!.sessionId;
    const r = await env.mgr.instruct(t.id, 'also add docs');
    expect(r.queued).toBe(false);
    await env.mgr.settled(t.id);
    const fin = env.store.getTask(t.id)!;
    expect(fin.status).toBe('succeeded');
    expect(fin.sessionId).toBe(sess);
    expect(env.store.listEvents(t.id).some((e) => e.kind === 'assistant_text' && e.data.text.includes('also add docs'))).toBe(true);
  });

  it('queues instructions sent during a run and injects them at the next resume', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=fail-then-succeed FAKE_DELAY=200', success: OK });
    env.mgr.enqueue(t.id);
    await new Promise((r) => setTimeout(r, 500));
    expect((await env.mgr.instruct(t.id, 'use tabs')).queued).toBe(true);
    await env.mgr.settled(t.id);
    const prompts = readFileSync(path.join(repoOf(env, t), '.bivouac', 'fake-prompts.log'), 'utf8');
    expect(prompts).toMatch(/=== run 2 resume=\S+[\s\S]*- use tabs/);
    expect(env.store.pendingInstructionCount(t.id)).toBe(0);
  });

  it('runs two tasks of the same project independently', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const a = addTask(env, remote, { prompt: 'a', success: OK });
    const b = addTask(env, remote, { prompt: 'b FAKE_SCENARIO=fail-then-succeed', success: OK });
    env.mgr.enqueue(a.id); env.mgr.enqueue(b.id);
    await Promise.all([env.mgr.settled(a.id), env.mgr.settled(b.id)]);
    expect(env.store.getTask(a.id)!.status).toBe('succeeded');
    expect(env.store.getTask(b.id)!.status).toBe('succeeded');
    expect(env.store.getTask(a.id)!.iteration).toBe(1);
    expect(env.store.getTask(b.id)!.iteration).toBe(2);
    expect(repoOf(env, a)).not.toBe(repoOf(env, b));
    expect(env.store.getTask(a.id)!.branch).not.toBe(env.store.getTask(b.id)!.branch);
  });

  it('respects maxParallel by queueing', async () => {
    const env = makeEnv({ maxParallel: 1 }); const remote = makeRemote();
    const a = addTask(env, remote, { prompt: 'a FAKE_DELAY=300', success: OK });
    const b = addTask(env, remote, { prompt: 'b', success: OK });
    env.mgr.enqueue(a.id); env.mgr.enqueue(b.id);
    expect(env.store.getTask(b.id)!.status).toBe('queued');
    await env.mgr.settled(a.id);
    await new Promise((r) => setTimeout(r, 100));
    await env.mgr.settled(b.id);
    expect(env.store.getTask(b.id)!.status).toBe('succeeded');
  });

  it('delete asks confirmation for unpushed commits, then cleans up', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x', success: OK });
    await run(env, t.id);
    await expect(env.mgr.destroy(t.id, false)).rejects.toMatchObject({ code: 'UNPUSHED' });
    await env.mgr.push(t.id);
    expect(env.store.getTask(t.id)!.pushed).toBe(true);
    await env.mgr.destroy(t.id, false);
    expect(env.store.getTask(t.id)).toBeNull();
    expect(existsSync(taskDirOf(env, t))).toBe(false);
  });

  it('recover() marks interrupted tasks as stopped', () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x' });
    env.store.setStatus(t.id, 'running');
    env.mgr.recover();
    expect(env.store.getTask(t.id)!.status).toBe('stopped');
  });
});
