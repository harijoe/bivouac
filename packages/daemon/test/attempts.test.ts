import { describe, expect, it } from 'vitest';
import { addTask, makeEnv, makeRemote } from './helpers.js';
import { connect } from './mcp-client.js';

const OK = 'grep -q ok fake-output.txt';
const user = { kind: 'user' as const, label: 'test' };

async function make(prompt = 'x FAKE_SCENARIO=always-fail', o: { maxIterations?: number; name?: string } = {}) {
  const env = makeEnv(); const remote = makeRemote();
  const t = addTask(env, remote, { prompt, success: OK, maxIterations: o.maxIterations ?? 3, name: o.name });
  env.mgr.enqueue(t.id);
  await env.mgr.settled(t.id);
  return { env, t, remote };
}

describe('history by attempt', () => {
  it('groups events by attempt, newest first, with cost, check result, last message and duration', async () => {
    const { env, t } = await make();
    const page = env.svc.attemptsPage(env.store.getTask(t.id)!);
    expect(page.attempts.map((a) => a.attempt)).toEqual([3, 2, 1]);
    expect(page.hasMore).toBe(false);
    for (const a of page.attempts) {
      expect(a.running).toBe(false);
      expect(a.costUsd).toBeCloseTo(0.01);
      expect(a.check).toMatchObject({ passed: false, command: OK });
      expect(a.lastMessage).toBeTruthy();
      expect(a.durationMs).toBeGreaterThanOrEqual(0);
      expect(a.firstEventId).toBeLessThanOrEqual(a.lastEventId);
    }
    // attempts do not overlap
    expect(page.attempts[2].lastEventId).toBeLessThan(page.attempts[1].firstEventId);
    // the end of the task is a marker after the newest attempt
    expect(page.trailing.map((m) => [m.kind, m.status])).toEqual([['state', 'max_iterations']]);
    expect(page.lastEventId).toBe(env.store.listEvents(t.id).at(-1)!.id);
  });

  it('puts instructions, stops, resumptions and limit changes between the attempts they led to', async () => {
    const { env, t } = await make('x FAKE_SCENARIO=always-fail', { maxIterations: 2 });
    // attempt 3 is triggered by an instruction on a resumed task, with a higher limit
    await env.svc.resumeTask(env.store.getTask(t.id)!, user, 'use tabs', { maxIterations: 3 });
    await env.mgr.settled(t.id);
    const page = env.svc.attemptsPage(env.store.getTask(t.id)!);
    expect(page.attempts.map((a) => a.attempt)).toEqual([3, 2, 1]);
    const before3 = page.attempts[0].markers.map((m) => (m.kind === 'state' ? `state:${m.status}` : m.kind));
    // order of what happened after attempt 2: it ran out of attempts, then limits changed / instruction / resumed
    expect(before3).toContain('state:max_iterations');
    expect(before3).toContain('instruction');
    expect(before3).toContain('limits');
    expect(before3).toContain('state:resumed');
    expect(before3.indexOf('state:max_iterations')).toBeLessThan(before3.indexOf('instruction'));
    expect(page.attempts[0].markers.find((m) => m.kind === 'instruction')).toMatchObject({ text: 'use tabs' });
    expect(page.attempts[1].markers).toEqual([]);
    expect(page.attempts[2].markers).toEqual([]);
    // an instruction queued during attempt 1 shows before attempt 2, where it is applied
    const b = await make('x FAKE_SCENARIO=always-fail FAKE_DELAY=300', { maxIterations: 2 });
    b.env.store.setStatus(b.t.id, 'stopped');
    b.env.store.addInstruction(b.t.id, 'later');
    const all = b.env.svc.attemptsPage(b.env.store.getTask(b.t.id)!).attempts;
    expect(all.map((a) => a.attempt)).toEqual([2, 1]);
    const trailing = b.env.svc.attemptsPage(b.env.store.getTask(b.t.id)!).trailing.map((m) => m.kind);
    expect(trailing).toEqual(['state', 'state', 'instruction']);
  });

  it('pages 15 at a time through the API and a task with hundreds of attempts stays cheap', async () => {
    const { env, t } = await make('x', { maxIterations: 1 });
    // 300 synthetic attempts
    const ins = env.store.db.prepare('INSERT INTO events(task_id, iteration, kind, data_json, created_at) VALUES (?,?,?,?,?)');
    env.store.db.transaction(() => {
      for (let n = 2; n <= 300; n++) {
        const at = new Date(Date.UTC(2026, 10, 10, 10, n)).toISOString();
        ins.run(t.id, n, 'status', JSON.stringify({ status: 'running' }), at);
        ins.run(t.id, n, 'assistant_text', JSON.stringify({ text: `message of attempt ${n}` }), at);
        for (let k = 0; k < 20; k++) ins.run(t.id, n, 'tool_use', JSON.stringify({ name: 'Bash', input: { command: `echo ${n} ${k}` }, id: `${n}-${k}` }), at);
        ins.run(t.id, n, 'result', JSON.stringify({ costUsd: 0.5 }), at);
        ins.run(t.id, n, 'check', JSON.stringify({ command: 'c', exitCode: n % 2, output: 'o' }), at);
      }
    })();
    const t0 = Date.now();
    const p1 = await (await env.call('GET', `/api/tasks/${t.id}/attempts?limit=15`)).json();
    expect(p1.attempts.map((a: any) => a.attempt)).toEqual(Array.from({ length: 15 }, (_, i) => 300 - i));
    expect(p1.hasMore).toBe(true);
    const p2 = await (await env.call('GET', `/api/tasks/${t.id}/attempts?limit=15&before=286`)).json();
    expect(p2.attempts[0].attempt).toBe(285);
    expect(p2.trailing).toEqual([]);
    expect(p1.attempts[0]).toMatchObject({ costUsd: 0.5, lastMessage: 'message of attempt 300', check: { passed: true } });
    expect(Date.now() - t0).toBeLessThan(1500);
    const last = await (await env.call('GET', `/api/tasks/${t.id}/attempts?limit=500&before=3`)).json();
    expect(last.attempts.map((a: any) => a.attempt)).toEqual([2, 1]);
    expect(last.hasMore).toBe(false);
    // the events of one attempt, in order, without the status pings
    const ev = await (await env.call('GET', `/api/tasks/${t.id}/attempts/7/events`)).json();
    expect(ev.events.map((e: any) => e.kind)).toEqual(['assistant_text', ...Array(20).fill('tool_use'), 'result', 'check']);
    // a few attempts by number
    const some = await (await env.call('GET', `/api/tasks/${t.id}/attempts?only=12,3,250`)).json();
    expect(some.attempts.map((a: any) => a.attempt)).toEqual([250, 12, 3]);
  });

  it('search finds attempts by message, tool call, check output and instruction', async () => {
    const { env, t } = await make('x FAKE_SCENARIO=always-fail', { maxIterations: 2 });
    env.store.addEvent(t.id, 'assistant_text', { text: 'The Needle is in attempt one' }, 1);
    env.store.addEvent(t.id, 'tool_use', { name: 'Bash', input: { command: 'grep haystack' }, id: 'z' }, 2);
    const find = async (q: string) => (await (await env.call('GET', `/api/tasks/${t.id}/history/search?q=${encodeURIComponent(q)}`)).json()).attempts;
    expect(await find('needle')).toEqual([1]);
    expect(await find('haystack')).toEqual([2]);
    expect(await find('nothing like this xyz')).toEqual([]);
    expect(await find('')).toEqual([]);
    await env.svc.resumeTask(env.store.getTask(t.id)!, user, 'please use the zebra approach');
    await env.mgr.settled(t.id);
    expect(await find('zebra')).toEqual([3]); // the attempt that applied it
  });

  it('get_task lists attempts newest first, paginated, with the same facts as the header', async () => {
    const { env, t } = await make('x FAKE_SCENARIO=always-fail', { maxIterations: 3 });
    const c = await connect(env);
    const get = async (args: object) => JSON.parse(((await c.callTool({ name: 'get_task', arguments: { project: 'demo', task: t.name, ...args } })) as any).content[0].text);
    const p1 = await get({ attempts_limit: 2 });
    expect(p1.attempts.map((a: any) => a.attempt)).toEqual([3, 2]);
    expect(p1.attemptsNextBefore).toBe(2);
    expect(p1.attempts[0]).toMatchObject({ running: false, costUsd: 0.01, check: 'failed (exit code 1)', startedAfter: [] });
    expect(p1.attempts[0].lastAgentMessage).toBeTruthy();
    const p2 = await get({ attempts_limit: 2, attempts_before: p1.attemptsNextBefore });
    expect(p2.attempts.map((a: any) => a.attempt)).toEqual([1]);
    expect(p2.attemptsNextBefore).toBeNull();
    await c.close();
  });
});
