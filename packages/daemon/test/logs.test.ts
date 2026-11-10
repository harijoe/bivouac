import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSandbox } from '../src/sandbox.js';
import { parseDevLines, parseServiceLines } from '../src/logs.js';
import { addTask, makeEnv, makeRemote } from './helpers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const devLines = (n: number) => Array.from({ length: n }, (_, i) => `12:00:${String(i % 60).padStart(2, '0')}.000 line ${i}`).join('\n') + '\n';

describe('log windows', () => {
  it('tail cuts on line boundaries, pages upwards and follows appends', async () => {
    const sb = new LocalSandbox(mkdtempSync(path.join(tmpdir(), 'bv-log-')));
    mkdirSync(path.join(sb.ws, '.bivouac'));
    const f = path.join(sb.ws, '.bivouac/dev.log');
    writeFileSync(f, devLines(2000)); // about 60 KB per 2000 lines: several windows
    const first = await sb.tail('.bivouac/dev.log', { bytes: 4096 });
    expect(first.end).toBe(first.size);
    expect(first.text.startsWith('12:')).toBe(true); expect(first.text.endsWith('\n')).toBe(true);
    // paging upwards never loses or repeats a line
    const seen: string[] = [];
    let before: number | undefined, guard = 0;
    for (;;) {
      const w = await sb.tail('.bivouac/dev.log', { before, bytes: 4096 });
      seen.unshift(...w.text.split('\n').filter(Boolean));
      if (w.start === 0 || ++guard > 100) break;
      before = w.start;
    }
    expect(seen).toHaveLength(2000); expect(seen[0]).toContain('line 0'); expect(seen[1999]).toContain('line 1999');
    // following: only complete lines are delivered, the partial one waits
    const cursor = first.size;
    appendFileSync(f, '12:01:00.000 complete\n12:01:01.000 partial');
    const a = await sb.tail('.bivouac/dev.log', { after: cursor });
    expect(a.text).toBe('12:01:00.000 complete\n');
    appendFileSync(f, ' now done\n');
    const b = await sb.tail('.bivouac/dev.log', { after: a.end });
    expect(b.text).toBe('12:01:01.000 partial now done\n');
    expect((await sb.tail('.bivouac/missing.log')).size).toBe(0);
  });
  it('parses timestamps, multi-byte text and service lines', () => {
    const lines = parseDevLines('12:00:00.001 héllo\nno stamp here\n12:00:00.002 ✓ ok\n', 100);
    expect(lines.map((l) => [l.ts, l.text])).toEqual([['12:00:00.001', 'héllo'], [null, 'no stamp here'], ['12:00:00.002', '✓ ok']]);
    expect(lines[1].id).toBe(100 + Buffer.byteLength('12:00:00.001 héllo\n'));
    expect(parseServiceLines('2026-11-09T22:00:00.123456789Z ready\n2026-11-09T22:00:01.000000000Z second\n').map((l) => l.text)).toEqual(['ready', 'second']);
  });
});

describe('task logs API', () => {
  it('lists the sources and serves pages for the dev server, setup and each check', async () => {
    const env = makeEnv();
    const t = addTask(env, makeRemote(), { prompt: 'x FAKE_SCENARIO=fail-then-succeed', success: 'echo checking; grep -q ok fake-output.txt', config: { setup: 'echo preparing' } });
    env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
    const sb = env.sandboxes.get(t.id)!;
    mkdirSync(path.join(sb.ws, '.bivouac'), { recursive: true });
    writeFileSync(path.join(sb.ws, '.bivouac/dev.log'), devLines(1200));
    const sources = await (await env.call('GET', `/api/tasks/${t.id}/logs/sources`)).json();
    expect(sources.map((s: any) => s.key)).toEqual(['setup', 'dev', 'check:1', 'check:2']);
    const dev = await (await env.call('GET', `/api/tasks/${t.id}/logs?source=dev&limit=300`)).json();
    expect(dev.lines).toHaveLength(300); expect(dev.lines[299].text).toBe('line 1199'); expect(dev.hasMore).toBe(true);
    const older = await (await env.call('GET', `/api/tasks/${t.id}/logs?source=dev&limit=300&before=${dev.lines[0].id}`)).json();
    expect(older.lines[299].text).toBe('line 899'); expect(older.lines.at(-1).id).toBeLessThan(dev.lines[0].id);
    const setup = await (await env.call('GET', `/api/tasks/${t.id}/logs?source=setup`)).json();
    expect(setup.lines.map((l: any) => l.text)).toEqual(['preparing']); expect(setup.hasMore).toBe(false);
    const check1 = await (await env.call('GET', `/api/tasks/${t.id}/logs?source=check:1`)).json();
    expect(check1.lines.map((l: any) => l.text)).toContain('checking');
    expect((await env.call('GET', '/api/tasks/9999/logs/sources')).status).toBe(404);
  });
  it('streams new lines as they are written', async () => {
    const env = makeEnv();
    const t = addTask(env, makeRemote(), { prompt: 'x' });
    env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
    const sb = env.sandboxes.get(t.id)!;
    mkdirSync(path.join(sb.ws, '.bivouac'), { recursive: true });
    const f = path.join(sb.ws, '.bivouac/dev.log');
    writeFileSync(f, '12:00:00.000 before\n');
    const first = await (await env.call('GET', `/api/tasks/${t.id}/logs?source=dev`)).json();
    const res = await env.call('GET', `/api/tasks/${t.id}/logs/stream?source=dev&after=${first.cursor}`);
    const reader = res.body!.getReader();
    setTimeout(() => appendFileSync(f, '12:00:05.000 live line\n'), 300);
    let got = '';
    const dec = new TextDecoder();
    for (let i = 0; i < 20 && !got.includes('live line'); i++) { const { value, done } = await reader.read(); if (done) break; got += dec.decode(value); }
    await reader.cancel();
    expect(got).toContain('event: lines'); expect(got).toContain('live line'); expect(got).not.toContain('before');
  });
});
