import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExecutorApp } from '../src/executor.js';
import { ExecutorClient } from '../src/remote.js';
import { LocalSandbox } from '../src/sandbox.js';
import { makeCfg, makeRemote } from './helpers.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';

async function start() {
  const cfg = makeCfg();
  const dirs = new Map<number, LocalSandbox>();
  const app = createExecutorApp(cfg, {} as never, { start: async () => ({ id: 'l', output: '', done: false, exitCode: null }), get: () => null, input: async () => {}, cancel: async () => {} },
    (id) => { if (!dirs.has(id)) dirs.set(id, new LocalSandbox(mkdtempSync(path.join(tmpdir(), 'bv-exec-')))); return dirs.get(id)!; });
  const srv = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 50));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close(), cfg };
}

describe('executor API', () => {
  it('refuses requests without the shared secret', async () => {
    const s = await start();
    expect((await fetch(s.url + '/health')).status).toBe(200);
    expect((await fetch(s.url + '/sandboxes/1/running?project=demo')).status).toBe(401);
    expect((await fetch(s.url + '/sandboxes/1/running?project=demo', { headers: { 'x-executor-token': 'wrong' } })).status).toBe(401);
    expect((await fetch(s.url + '/claude-login', { method: 'POST' })).status).toBe(401);
    s.close();
  });

  it('validates task ids, project names, cwd and command shape', async () => {
    const s = await start();
    const c = new ExecutorClient(s.url, s.cfg.executorToken);
    await expect(c.call('GET', '/sandboxes/abc/running?project=demo')).rejects.toThrow(/bad task id/);
    await expect(c.call('GET', '/sandboxes/1/running?project=../etc')).rejects.toThrow(/bad task id or project/);
    await expect(c.call('POST', '/sandboxes/1/exec?project=demo', { cmd: 'rm -rf /' })).rejects.toThrow(/array of strings/);
    await expect(c.call('POST', '/sandboxes/1/exec?project=demo', { cmd: ['ls'], cwd: '/etc' })).rejects.toThrow(/inside \/workspace/);
    s.close();
  });

  it('streams exec output and exit codes, and aborting kills the process', async () => {
    const s = await start();
    const c = new ExecutorClient(s.url, s.cfg.executorToken);
    const sb = c.sandbox(1, 'demo');
    const out: string[] = [];
    // LocalSandbox ignores cwd restrictions of the container; the API only checks the prefix, so omit it
    expect(await sb.exec(['sh', '-c', 'echo hello; echo oops >&2; exit 3'], { onData: (d, st) => out.push(`${st}:${d.trim()}`) })).toBe(3);
    expect(out).toEqual(expect.arrayContaining(['stdout:hello', 'stderr:oops']));
    const ac = new AbortController();
    const t0 = Date.now();
    const p = sb.exec(['sleep', '30'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    expect(await p).toBe(143);
    expect(Date.now() - t0).toBeLessThan(5000);
    s.close();
  });

  it('files and git go through the API (path traversal refused)', async () => {
    const s = await start();
    const c = new ExecutorClient(s.url, s.cfg.executorToken);
    const sb = c.sandbox(2, 'demo');
    await sb.writeFile('.bivouac/x.json', '{"a":1}');
    expect(await sb.readFile('.bivouac/x.json')).toBe('{"a":1}');
    expect(await sb.readFile('nope')).toBeNull();
    await expect(sb.readFile('../../etc/passwd')).rejects.toThrow(/escapes the workspace/);
    const remote = makeRemote({ 'bivouac.yml': 'success: "true"\n' });
    expect(await sb.prepareRepo({ repoUrl: remote, token: null, branch: 'agent/x', base: 'main' })).toBe(true);
    expect(await sb.prepareRepo({ repoUrl: remote, token: null, branch: 'agent/x', base: 'main' })).toBe(false);
    expect(await sb.readFile('repo/bivouac.yml')).toContain('success');
    expect(await sb.unpushed()).toBe(0);
    s.close();
  });
});
