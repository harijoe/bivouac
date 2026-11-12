// Needs a Chromium: BIVOUAC_CHROMIUM, google-chrome / chromium on the PATH, or a Playwright download. Skipped without one
// (the Docker integration test takes real screenshots with the task image in CI).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { addTask, makeEnv, makeRemote } from './helpers.js';
import { connect } from './mcp-client.js';

const findChromium = (): string | null => {
  const cands = [process.env.BIVOUAC_CHROMIUM, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean) as string[];
  const pw = path.join(homedir(), '.cache/ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw)) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) { const p = path.join(pw, d, rel); if (existsSync(p)) cands.push(p); }
  }
  // a candidate must actually start (a Playwright download can lack system libraries)
  return cands.find((c) => { try { execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; } }) ?? null;
};
const chromium = findChromium();
let playwright: string | null = null;
try { playwright = createRequire(import.meta.url).resolve('playwright-core'); } catch { /* not installed */ }
const can = !!chromium && !!playwright;

let server: Server, port = 0;
beforeAll(async () => {
  if (!can) return;
  process.env.BIVOUAC_SHOT_SCRIPT = path.resolve(import.meta.dirname, '../../task-image/shot.mjs');
  process.env.BIVOUAC_PLAYWRIGHT = playwright!;
  process.env.BIVOUAC_CHROMIUM = chromium!;
  server = createServer((q, r) => {
    r.setHeader('content-type', 'text/html');
    if (q.url === '/') r.end('<html><head><title>Home</title></head><body><h1>Hello</h1><p>' + 'text '.repeat(200) + '</p></body></html>');
    else if (q.url === '/broken') r.end('<html><head><title>Broken</title></head><body><h1>Broken</h1><script>console.error("boom from page");fetch("/missing.json")</script></body></html>');
    else if (q.url === '/blank') r.end('<html><head><title>Blank</title></head><body></body></html>');
    else { r.statusCode = 404; r.end('nope'); }
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  port = (server.address() as any).port;
});
afterAll(() => { server?.close(); delete process.env.BIVOUAC_SHOT_SCRIPT; });

describe.skipIf(!can)('screenshots of the preview', () => {
  const conf = (p: number, pages: string[]) => ({ dev: { command: 'sleep 1000', port: p }, preview: { screenshots: pages } });

  it('photographs the listed pages at 375 and 1280 px, detects errors and blank pages, serves the images', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it', success: 'grep -q ok fake-output.txt', config: conf(port, ['/', '/broken', '/blank', '/nope']) });
    env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
    const task = env.store.getTask(t.id)!;
    expect(task.status).toBe('succeeded');
    const [att] = env.svc.shotsOf(task);
    expect(att).toMatchObject({ attempt: 1, checkPassed: true, error: null });
    expect(att.shots).toHaveLength(8);
    const by = (page: string, w: number) => att.shots.find((s) => s.page === page && s.width === w)!;
    expect(by('/', 375)).toMatchObject({ ok: true, httpStatus: 200, title: 'Home', blank: false, problems: [] });
    expect(by('/', 1280).ok).toBe(true);
    expect(by('/broken', 1280)).toMatchObject({ ok: false, httpStatus: 200 });
    expect(by('/broken', 1280).consoleErrors.join(' ')).toMatch(/boom from page/);
    expect(by('/broken', 1280).failedRequests[0]).toMatchObject({ status: 404 });
    expect(by('/broken', 1280).problems.map((p) => p.kind)).toEqual(expect.arrayContaining(['console', 'request']));
    expect(by('/blank', 375)).toMatchObject({ ok: false, blank: true });
    expect(by('/blank', 375).problems.map((p) => p.kind)).toContain('blank');
    expect(by('/nope', 375)).toMatchObject({ ok: false, httpStatus: 404 });
    expect(by('/nope', 375).problems.map((p) => p.kind)).toContain('http');
    // images: JPEG, a small copy that is smaller
    const full = env.svc.shotImage(task, by('/', 1280).id, 'full'), small = env.svc.shotImage(task, by('/', 1280).id, 'small');
    expect(full.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(small.length).toBeLessThan(full.length);
    const r = await env.call('GET', `/api/tasks/${t.id}/shots/${by('/', 375).id}/image?variant=small`);
    expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(((await (await env.call('GET', `/api/tasks/${t.id}/shots`)).json()) as any)[0].shots).toHaveLength(8);
    // the capture is in the history, and the workspace is left clean
    expect(env.store.listEvents(t.id).find((e) => e.data.subtype === 'screenshots')!.data).toMatchObject({ ok: true, count: 8, problems: 6 });
    expect(existsSync(path.join(env.sandboxes.get(t.id)!.ws, '.bivouac/shots'))).toBe(false);
    // MCP: get_task carries the images of the last attempt (at most 4) and their errors
    const c = await connect(env);
    const res: any = await c.callTool({ name: 'get_task', arguments: { project: 'demo', task: task.name } });
    const images = res.content.filter((x: any) => x.type === 'image');
    expect(images).toHaveLength(4);
    expect(images[0].mimeType).toBe('image/jpeg');
    const meta = JSON.parse(res.content[0].text);
    expect(meta.screenshots.pages.find((p: any) => p.page === '/broken' && p.width === 1280).consoleErrors.join()).toMatch(/boom/);
    const one: any = await c.callTool({ name: 'get_attempt_screenshots', arguments: { project: 'demo', task: task.name, attempt: 1, width: 375 } });
    expect(one.content.filter((x: any) => x.type === 'image')).toHaveLength(4);
    expect(JSON.parse(one.content[0].text).screenshots.pages.every((p: any) => p.width === 375)).toBe(true);
    const missing: any = await c.callTool({ name: 'get_attempt_screenshots', arguments: { project: 'demo', task: task.name, attempt: 7 } });
    expect(missing.isError).toBe(true);
    await c.close();
    // destroyed with the task
    const dir = env.mgr.shots.dirOf(t.id);
    expect(existsSync(dir)).toBe(true);
    await env.mgr.destroy(t.id, true);
    expect(existsSync(dir)).toBe(false);
  }, 120000);

  it('records the outcome of the check; a dev server that is down is reported and does not fail the attempt', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it FAKE_SCENARIO=fail-then-succeed', success: 'grep -q ok fake-output.txt', config: conf(1, ['/']) });
    env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
    expect(env.store.getTask(t.id)!.status).toBe('succeeded');
    const runs = env.svc.shotsOf(env.store.getTask(t.id)!);
    expect(runs.map((r) => [r.attempt, r.checkPassed])).toEqual([[2, true], [1, false]]);
    expect(runs[0].error).toMatch(/does not answer/);
    expect(runs[0].shots).toEqual([]);
    expect(env.store.listEvents(t.id).filter((e) => e.data.subtype === 'screenshots').every((e) => e.data.ok === false)).toBe(true);
  }, 120000);
});

describe('screenshot storage is bounded', () => {
  it('keeps the newest attempts and removes the oldest, with their files', () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'x' });
    const dir = env.mgr.shots.dirOf(t.id);
    const ins = env.store.db.prepare("INSERT INTO shots(task_id,attempt,page,width,ok,bytes) VALUES(?,?,'/',375,1,?)");
    const run = env.store.db.prepare('INSERT INTO shot_runs(task_id,attempt) VALUES(?,?)');
    for (let a = 1; a <= 15; a++) {
      const id = Number(ins.run(t.id, a, 1000).lastInsertRowid); run.run(t.id, a);
      mkdirSync(path.join(dir, `a${a}`), { recursive: true }); writeFileSync(path.join(dir, `a${a}`, `${id}.jpg`), 'x');
    }
    env.mgr.shots.prune(t.id);
    expect(env.mgr.shots.list(t.id, { limit: 50 }).map((r) => r.attempt)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(existsSync(path.join(dir, 'a3'))).toBe(false);
    expect(existsSync(path.join(dir, 'a4'))).toBe(true);
    // a byte budget applies too: one huge old attempt goes, the newest always stays
    env.store.db.prepare('UPDATE shots SET bytes=? WHERE attempt=?').run(70 * 1024 * 1024, 15);
    env.mgr.shots.prune(t.id);
    expect(env.mgr.shots.list(t.id, { limit: 50 }).map((r) => r.attempt)).toEqual([15]);
  });
});
