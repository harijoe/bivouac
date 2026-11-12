import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SUPERVISOR } from './helpers.js';

const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
const SERVER = `node -e "require('http').createServer((q,r)=>{r.statusCode=q.url==='/health'&&require('fs').existsSync('/tmp/bv-unhealthy-'+process.env.PORT)?503:200;r.end('ok')}).listen(process.env.PORT,'127.0.0.1')"`;

let sup: ChildProcess | null = null;
afterEach(() => { sup?.kill('SIGKILL'); sup = null; });

async function setup(command: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bv-sup-'));
  const port = await freePort();
  sup = spawn('node', [SUPERVISOR], { env: { ...process.env, BIVOUAC_STATE_DIR: dir, BIVOUAC_HEALTH_INTERVAL_MS: '100', BIVOUAC_BACKOFF_UNIT_MS: '10', BIVOUAC_HUNG_MS: '700', ...env }, stdio: 'ignore' });
  writeFileSync(path.join(dir, 'dev.json'), JSON.stringify({ command, port, cwd: dir, ...extra }));
  const health = () => (existsSync(path.join(dir, 'health.json')) ? JSON.parse(readFileSync(path.join(dir, 'health.json'), 'utf8')) : null);
  const until = async (fn: (h: any) => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const h = health(); if (h && fn(h)) return h; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`timeout; last health: ${JSON.stringify(health())}`);
  };
  return { dir, port, health, until };
}

describe('supervisor health', () => {
  it('reports starting then healthy, and restarts a server that died, with the cause', async () => {
    const s = await setup(SERVER);
    const first = await s.until((h) => h.state === 'healthy');
    expect(first.restarts).toBe(0);
    expect(first.lastHealthyAt).toBeTruthy();
    process.kill(-s.health().pid, 'SIGKILL'); // the dev server dies (the whole process group)
    const down = await s.until((h) => h.state === 'unhealthy');
    expect(down.cause).toMatch(/exited \(code .*signal SIGKILL|exited/);
    expect(down.restarts).toBe(1);
    const back = await s.until((h) => h.state === 'healthy');
    expect(back.restarts).toBe(1);
    expect(back.cause).toMatch(/exited/); // the last cause stays visible after the recovery
    expect(Date.parse(back.since)).toBeGreaterThanOrEqual(Date.parse(down.since));
    expect(readFileSync(path.join(s.dir, 'dev.log'), 'utf8')).toMatch(/restarting in/);
  });

  it('gives up after a limited number of restarts and says why', async () => {
    const s = await setup('echo boom-from-app; exit 3');
    const h = await s.until((x) => x.state === 'down');
    expect(h.restarts).toBe(8);
    expect(h.cause).toMatch(/exited \(code 3\)/);
    expect(h.cause).toMatch(/boom-from-app/);
    expect(h.nextRetryAt).toBeNull();
    // it stays down (no further restarts)
    await new Promise((r) => setTimeout(r, 300));
    expect(s.health().restarts).toBe(8);
    expect(s.health().state).toBe('down');
  });

  it('restarts on request, even after giving up', { timeout: 30000 }, async () => {
    const s = await setup('exit 1');
    await s.until((x) => x.state === 'down');
    writeFileSync(path.join(s.dir, 'dev.json'), JSON.stringify({ command: SERVER, port: s.port, cwd: s.dir }));
    const h = await s.until((x) => x.state === 'healthy');
    expect(h.restarts).toBe(0);
    const pid = h.pid;
    writeFileSync(path.join(s.dir, 'restart.req'), '1');
    const again = await s.until((x) => x.state === 'healthy' && x.pid !== pid);
    expect(again.pid).not.toBe(pid);
  });

  it('uses the configured health path (a 5xx there is unhealthy) and kills a server that stops answering', async () => {
    const s = await setup(SERVER, { healthPath: '/health' });
    await s.until((x) => x.state === 'healthy');
    writeFileSync(`/tmp/bv-unhealthy-${s.port}`, '1');
    try {
      const h = await s.until((x) => x.state === 'unhealthy');
      expect(h.cause).toMatch(/stopped answering on port .* \(\/health\)/);
    } finally { try { (await import('node:fs')).rmSync(`/tmp/bv-unhealthy-${s.port}`); } catch { /* */ } }
    await s.until((x) => x.state === 'healthy');
  });
});
