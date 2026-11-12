import { describe, expect, it } from 'vitest';
import { addProject, addTask, makeEnv, makeRemote } from './helpers.js';

describe('input handling found in the v0.5 review', () => {
  it('rejects limits that would stop a new task at once', async () => {
    const env = makeEnv();
    addProject(env, makeRemote());
    for (const bad of [{ maxTokens: -5 }, { maxTokens: 'abc' }, { maxIterations: 1.5 }, { maxIterations: 5000 }]) {
      const r = await env.call('POST', '/api/tasks', { project: 'demo', prompt: 'x', ...bad });
      expect(r.status).toBe(400);
    }
  });

  it('finds a project whose name is a number, and a project by id', () => {
    const env = makeEnv();
    const remote = makeRemote();
    env.store.createProject({ name: 'other', repoUrl: remote, defaultBranch: 'main' });
    const numeric = env.store.createProject({ name: '2048', repoUrl: remote, defaultBranch: 'main' });
    expect(env.svc.resolveProject('2048').id).toBe(numeric.id);
    expect(env.svc.resolveProject('1').name).toBe('other');
  });

  it('does not change limits when resuming a task that is running or queued', async () => {
    const env = makeEnv();
    const t = addTask(env, makeRemote(), { prompt: 'x' });
    env.store.setStatus(t.id, 'queued');
    await expect(env.svc.resumeTask(env.store.getTask(t.id)!, { label: 't' } as any, undefined, { maxCostUsd: 77 })).rejects.toMatchObject({ code: 'already_running' });
    expect(env.store.getTask(t.id)!.maxCostUsd).not.toBe(77);
  });
});
