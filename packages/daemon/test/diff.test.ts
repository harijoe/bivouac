import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { addTask, makeEnv, makeRemote, repoOf } from './helpers.js';
import { checkRef } from '../src/gitdiff.js';

async function run(env: ReturnType<typeof makeEnv>, id: number) {
  env.mgr.enqueue(id);
  await env.mgr.settled(id);
  return env.store.getTask(id)!;
}

describe('diff per attempt', () => {
  it('records start and end of every attempt and diffs each one, committed or not', async () => {
    const env = makeEnv(); const remote = makeRemote({ 'README.md': 'hi\n', 'src.txt': 'one\ntwo\n' });
    // attempt 1: the agent commits fake-output.txt + fake-log.txt (check fails); attempt 2: same files again, succeeds
    const t = addTask(env, remote, { prompt: 'do it FAKE_SCENARIO=fail-then-succeed', success: 'grep -q ok fake-output.txt' });
    const done = await run(env, t.id);
    expect(done.status).toBe('succeeded');
    expect(done.iteration).toBe(2);
    const a1 = await env.svc.attemptDiff(done, 1);
    expect(a1.files.map((f) => f.path)).toEqual(['fake-log.txt', 'fake-output.txt']);
    expect(a1.files.find((f) => f.path === 'fake-output.txt')).toMatchObject({ status: 'added', added: 1, deleted: 0 });
    expect(a1.committed).toBe(true);
    expect(a1.commits).toHaveLength(1);
    expect(a1.commits[0].subject).toMatch(/fake claude run 1/);
    // attempt 2 only changes what attempt 1 left behind
    const a2 = await env.svc.attemptDiff(done, 2);
    expect(a2.files.find((f) => f.path === 'fake-output.txt')).toMatchObject({ status: 'modified', added: 1, deleted: 1 });
    expect(a2.files.find((f) => f.path === 'fake-log.txt')).toMatchObject({ added: 1, deleted: 0 });
    const patch = await env.svc.attemptPatch(done, 2, 'fake-output.txt');
    expect(patch.lines.join('\n')).toContain('-bad');
    expect(patch.lines.join('\n')).toContain('+ok');
    // the whole task against its base branch
    const base = await env.svc.attemptDiff(done, 'base');
    expect(base.files.map((f) => f.path)).toEqual(['fake-log.txt', 'fake-output.txt']);
    expect(base.files.find((f) => f.path === 'fake-output.txt')).toMatchObject({ status: 'added', added: 1 });
    expect(base.against).toBe('origin/main');
    // whole patch, paged
    const all = await env.svc.attemptPatch(done, 'base', undefined, 0, 5);
    expect(all.lines).toHaveLength(5);
    expect(all.truncated).toBe(true);
    expect(all.nextOffset).toBe(5);
    const rest = await env.svc.attemptPatch(done, 'base', undefined, 5, 500);
    expect(rest.nextOffset).toBeNull();
    expect(all.total).toBe(rest.total);
  });

  it('shows the changes of an attempt that did not commit, and an attempt that changed nothing', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=always-fail FAKE_NOCOMMIT=1', success: 'false', maxIterations: 2 });
    const done = await run(env, t.id);
    expect(done.status).toBe('max_iterations');
    const a1 = await env.svc.attemptDiff(done, 1);
    expect(a1.committed).toBe(false);
    expect(a1.uncommitted).toBe(true);
    expect(a1.files.map((f) => f.path)).toContain('fake-output.txt');
    expect(a1.commits).toEqual([]);
    // attempt 2 rewrites the same content with one more log line: only the log changed
    const a2 = await env.svc.attemptDiff(done, 2);
    expect(a2.files.map((f) => f.path)).toEqual(['fake-log.txt']);
  });

  it('an attempt where nothing changed has an empty diff; the agent staging area is untouched', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x FAKE_SCENARIO=stuck', success: 'false', maxIterations: 4 });
    const done = await run(env, t.id);
    expect(done.status).toBe('stuck');
    const last = await env.svc.attemptDiff(done, done.iteration);
    expect(last.files).toEqual([]);
    expect(last.totals).toEqual({ files: 0, added: 0, deleted: 0 });
    const repo = repoOf(env, done);
    expect(execSync('git diff --cached --name-only', { cwd: repo, encoding: 'utf8' })).toBe('');
  });

  it('marks uncommitted work made after the last commit and reports it on the live task', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it', success: 'grep -q ok fake-output.txt' });
    const done = await run(env, t.id);
    writeFileSync(path.join(repoOf(env, done), 'later.txt'), 'x\n');
    const base = await env.svc.attemptDiff(done, 'base');
    expect(base.files.map((f) => f.path)).toContain('later.txt');
    expect(base.uncommitted).toBe(true);
  });

  it('refuses unsafe revisions and unknown attempts', async () => {
    expect(() => checkRef('--output=/etc/passwd')).toThrow();
    expect(() => checkRef('origin/../x')).toThrow();
    expect(checkRef('origin/main')).toBe('origin/main');
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it', success: 'true' });
    const done = await run(env, t.id);
    await expect(env.svc.attemptDiff(done, 9)).rejects.toThrow(/No change record/);
    await expect(env.svc.attemptPatch(done, 1, 'nope.txt')).rejects.toThrow(/did not change/);
  });

  it('serves the diff over the API and over MCP', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it', success: 'grep -q ok fake-output.txt' });
    await run(env, t.id);
    const r = await env.call('GET', `/api/tasks/${t.id}/diff/1`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.totals.files).toBe(2);
    const p = await env.call('GET', `/api/tasks/${t.id}/diff/1/patch?file=fake-output.txt`);
    expect(((await p.json()) as any).lines.join('\n')).toContain('+ok');
    const d = await env.svc.describeTask(env.store.getTask(t.id)!);
    expect(d.attempts[0].changes).toMatchObject({ files: 2 });
  });
});
