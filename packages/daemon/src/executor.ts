import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import Dockerode from 'dockerode';
import { randomBytes } from 'node:crypto';
import { parseServices } from '@bivouac/shared';
import type { DaemonConfig } from './config.js';
import { safeEqual } from './crypto.js';
import { DockerSandbox, type Sandbox } from './sandbox.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const cleanEnv = (e: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((e ?? {}) as Record<string, unknown>)) if (ENV_KEY.test(k) && typeof v === 'string') out[k] = v;
  return out;
};

/** Pseudo-terminal sessions used to run `claude setup-token` in a throwaway container. */
export interface LoginSession { id: string; output: string; done: boolean; exitCode: number | null; /** offset in `output` of the last code sent (0 = none) */ inputAt: number }

/**
 * Types a code into the CLI's prompt. The CLI (Ink) treats text and Enter arriving in one write as a paste and the
 * Enter then does not submit, so the text goes first and Enter follows in a separate write after a short pause.
 */
export async function typeCode(write: (data: string) => void, text: string, pauseMs = 200): Promise<void> {
  write(text.replace(/[\r\n]+$/, ''));
  await new Promise((r) => setTimeout(r, pauseMs));
  write('\r');
}
export interface LoginDriver {
  start(): Promise<LoginSession>;
  get(id: string): LoginSession | null;
  input(id: string, text: string): Promise<void>;
  cancel(id: string): Promise<void>;
}

export class DockerLoginDriver implements LoginDriver {
  private sessions = new Map<string, LoginSession & { container: Dockerode.Container; stream?: NodeJS.ReadWriteStream; timer: NodeJS.Timeout }>();
  constructor(private docker: Dockerode, private cfg: Pick<DaemonConfig, 'namePrefix' | 'taskImage' | 'claudeBin'>) {}

  async start(): Promise<LoginSession> {
    for (const s of this.sessions.values()) if (!s.done) await this.cancel(s.id);
    const id = randomBytes(6).toString('hex');
    const container = await this.docker.createContainer({
      name: `${this.cfg.namePrefix}-login-${id}`, Image: this.cfg.taskImage, Tty: true, OpenStdin: true, StdinOnce: false,
      Entrypoint: [], Cmd: [this.cfg.claudeBin, 'setup-token'], Labels: { 'bivouac.managed': 'true', 'bivouac.login': id },
      Env: ['BROWSER=true', 'TERM=xterm-256color', 'NO_COLOR=1'],
      HostConfig: { AutoRemove: true, Memory: 512 * 1024 ** 2, NanoCpus: 1e9, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] },
    });
    const s: LoginSession & { container: Dockerode.Container; stream?: NodeJS.ReadWriteStream; timer: NodeJS.Timeout } =
      { id, output: '', done: false, exitCode: null, inputAt: 0, container, timer: setTimeout(() => void this.cancel(id), 10 * 60_000) };
    this.sessions.set(id, s);
    const st = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
    s.stream = st as unknown as NodeJS.ReadWriteStream;
    st.on('data', (b: Buffer) => { if (s.output.length < 1_000_000) s.output += b.toString('utf8'); });
    await container.start();
    await container.resize({ h: 50, w: 500 }).catch(() => {});
    void container.wait().then((r) => { s.done = true; s.exitCode = r.StatusCode; clearTimeout(s.timer); }).catch(() => { s.done = true; s.exitCode = -1; });
    return { id, output: '', done: false, exitCode: null, inputAt: 0 };
  }
  get(id: string) {
    const s = this.sessions.get(id);
    return s ? { id: s.id, output: s.output, done: s.done, exitCode: s.exitCode, inputAt: s.inputAt } : null;
  }
  async input(id: string, text: string) {
    const s = this.sessions.get(id);
    if (!s || s.done) throw new Error('login session is not running');
    s.inputAt = s.output.length;
    await typeCode((d) => s.stream!.write(d), text);
  }
  async cancel(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    s.done = true;
    await s.container.kill().catch(() => {});
    this.sessions.delete(id);
  }
}

/**
 * Narrow, authenticated API in front of Docker. It is the only component with the Docker socket and is reachable
 * only from the web service. It never accepts images, mounts, networks or labels from its caller.
 */
export function createExecutorApp(cfg: DaemonConfig, docker: Dockerode, login: LoginDriver = new DockerLoginDriver(docker, cfg), sandboxFor?: (id: number, project: string) => Sandbox) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (!cfg.executorToken || !safeEqual(c.req.header('x-executor-token') ?? '', cfg.executorToken)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
  const mk = (id: number, project: string): Sandbox => sandboxFor?.(id, project)
    ?? new DockerSandbox(docker, { namePrefix: cfg.namePrefix, taskId: id, project, dataDir: cfg.dataDir, image: cfg.taskImage, traefikContainer: cfg.traefikContainer, uid: cfg.taskUid });
  const sb = (c: { req: { param: (k: string) => string; query: (k: string) => string | undefined } }) => {
    const id = Number(c.req.param('id'));
    const project = c.req.query('project') ?? '';
    if (!Number.isInteger(id) || id < 1 || !SLUG.test(project)) throw new Error('bad task id or project');
    return mk(id, project);
  };
  const wrap = (fn: (c: any) => Promise<Response>) => async (c: any) => {
    try { return await fn(c); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 400); }
  };

  app.post('/sandboxes/:id/prepare', wrap(async (c) => {
    const b = await c.req.json();
    return c.json({ cloned: await sb(c).prepareRepo({ repoUrl: String(b.repoUrl), token: b.token ?? null, branch: String(b.branch), base: String(b.base) }) });
  }));
  app.post('/sandboxes/:id/start', wrap(async (c) => {
    const b = await c.req.json();
    await sb(c).start({ taskId: Number(c.req.param('id')), project: String(c.req.query('project')), env: cleanEnv(b.env), cpus: b.cpus, memory: b.memory, services: b.services === undefined ? {} : parseServices(b.services) });
    return c.json({ ok: true });
  }));
  app.post('/sandboxes/:id/exec', wrap(async (c) => {
    const b = await c.req.json();
    const sandbox = sb(c);
    if (!Array.isArray(b.cmd) || !b.cmd.every((x: unknown) => typeof x === 'string')) throw new Error('cmd must be an array of strings');
    if (b.cwd !== undefined && !String(b.cwd).startsWith('/workspace')) throw new Error('cwd must be inside /workspace');
    const ac = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => ac.abort());
    c.header('content-type', 'application/x-ndjson');
    return stream(c, async (s) => {
      s.onAbort(() => ac.abort());
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const push = (o: object) => { queue.push(JSON.stringify(o) + '\n'); wake?.(); };
      const done = sandbox.exec(b.cmd, { cwd: b.cwd, env: cleanEnv(b.env), signal: ac.signal, onData: (d, st) => push({ t: st === 'stdout' ? 'o' : 'e', d }) })
        .then((code) => push({ x: code }), (e) => push({ x: 1, err: String(e?.message ?? e) }));
      let finished = false;
      void done.then(() => { finished = true; wake?.(); });
      while (!finished || queue.length) {
        while (queue.length) await s.write(queue.shift()!);
        if (!finished) await new Promise<void>((r) => { wake = r; });
      }
    });
  }));
  app.get('/sandboxes/:id/running', wrap(async (c) => c.json({ running: await sb(c).isRunning() })));
  app.post('/sandboxes/:id/stop', wrap(async (c) => { await sb(c).stop(); return c.json({ ok: true }); }));
  app.post('/sandboxes/:id/destroy', wrap(async (c) => { await sb(c).destroy(); return c.json({ ok: true }); }));
  app.post('/sandboxes/:id/push', wrap(async (c) => { const b = await c.req.json(); await sb(c).push({ branch: String(b.branch), token: b.token ?? null }); return c.json({ ok: true }); }));
  app.get('/sandboxes/:id/unpushed', wrap(async (c) => c.json({ count: await sb(c).unpushed() })));
  app.get('/sandboxes/:id/tail', wrap(async (c) => {
    const n = (k: string) => (c.req.query(k) !== undefined ? Number(c.req.query(k)) : undefined);
    return c.json(await sb(c).tail(c.req.query('path') ?? '', { before: n('before'), after: n('after'), bytes: n('bytes') }));
  }));
  app.get('/sandboxes/:id/service-logs', wrap(async (c) => c.json({ text: await sb(c).serviceLogs(c.req.query('name') ?? '', Number(c.req.query('tail') ?? 500)) })));
  app.get('/sandboxes/:id/service-states', wrap(async (c) => c.json({ states: await sb(c).serviceStates() })));
  app.post('/sandboxes/:id/service-restart', wrap(async (c) => { await sb(c).restartService(c.req.query('name') ?? ''); return c.json({ ok: true }); }));
  app.post('/sandboxes/:id/mark', wrap(async (c) => c.json({ mark: await sb(c).mark() })));
  app.post('/sandboxes/:id/diff-summary', wrap(async (c) => {
    const b = await c.req.json();
    const h = b.heads && typeof b.heads === 'object' ? { from: b.heads.from ? String(b.heads.from) : null, to: b.heads.to ? String(b.heads.to) : null } : undefined;
    return c.json(await sb(c).diffSummary(String(b.from), String(b.to), h));
  }));
  app.post('/sandboxes/:id/diff-patch', wrap(async (c) => {
    const b = await c.req.json();
    if (!Array.isArray(b.paths) || !b.paths.every((x: unknown) => typeof x === 'string')) throw new Error('paths must be an array of strings');
    return c.json(await sb(c).diffPatch(String(b.from), String(b.to), b.paths, Number(b.offset ?? 0), Number(b.limit ?? 400)));
  }));
  app.get('/sandboxes/:id/binary', wrap(async (c) => { const b = await sb(c).readBinary(c.req.query('path') ?? ''); return c.json({ base64: b ? b.toString('base64') : null }); }));
  app.get('/sandboxes/:id/fingerprint', wrap(async (c) => c.json({ hash: await sb(c).fingerprint() })));
  app.get('/sandboxes/:id/file', wrap(async (c) => c.json({ content: await sb(c).readFile(c.req.query('path') ?? '') })));
  app.put('/sandboxes/:id/file', wrap(async (c) => { const b = await c.req.json(); await sb(c).writeFile(String(b.path), String(b.content)); return c.json({ ok: true }); }));

  // One-click update: an ephemeral updater container runs the *new* version's apply.sh on the host (see decisions.md).
  const updaterName = `${cfg.namePrefix}-updater`;
  app.get('/update/running', wrap(async (c) => c.json({ running: await docker.getContainer(updaterName).inspect().then((i) => i.State.Running, () => false) })));
  app.post('/update/start', wrap(async (c) => {
    const b = await c.req.json();
    const version = String(b.version ?? '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('bad version');
    const m = /^(.+)\/bivouac-daemon:[^/]+$/.exec(cfg.daemonImage);
    if (!m) throw new Error('this installation does not know its image registry: update with the installer instead');
    if (await docker.getContainer(updaterName).inspect().then((i) => i.State.Running, () => false)) throw new Error('an update is already running');
    await docker.getContainer(updaterName).remove({ force: true }).catch(() => {});
    const image = `${m[1]}/bivouac-daemon:${version}`;
    if (!(await docker.getImage(image).inspect().then(() => true, () => false))) await new Promise<void>((resolve, reject) => docker.pull(image, (err: Error | null, st: NodeJS.ReadableStream) => {
      if (err) return reject(new Error(`cannot download ${image}: ${err.message}`));
      docker.modem.followProgress(st, (e: Error | null) => (e ? reject(new Error(`cannot download ${image}: ${e.message}`)) : resolve()));
    }));
    const c2 = await docker.createContainer({
      name: updaterName, Image: image, Entrypoint: ['sh', '-c'], Labels: { 'bivouac.managed': 'true', 'bivouac.updater': 'true' }, Env: [`V=${version}`, `T=${process.env.BIVOUAC_HEALTH_TIMEOUT ?? '150'}`],
      Cmd: ['cp /app/apply.sh /host-opt/apply.sh && cp /app/uninstall.sh /host-opt/uninstall.sh && chmod 755 /host-opt/apply.sh /host-opt/uninstall.sh && exec nsenter -t 1 -m -u -i -n -p -- env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin BIVOUAC_HEALTH_TIMEOUT="$T" /opt/bivouac/apply.sh update "$V"'],
      HostConfig: { Privileged: true, PidMode: 'host', AutoRemove: true, Binds: [`${cfg.hostOptDir}:/host-opt`] },
    });
    await c2.start();
    return c.json({ ok: true });
  }));

  app.post('/claude-login', wrap(async (c) => c.json(await login.start())));
  app.get('/claude-login/:id', wrap(async (c) => { const s = login.get(c.req.param('id')); return s ? c.json(s) : c.json({ error: 'no such login session' }, 404); }));
  app.post('/claude-login/:id/input', wrap(async (c) => { const b = await c.req.json(); await login.input(c.req.param('id'), String(b.text ?? '')); return c.json({ ok: true }); }));
  app.delete('/claude-login/:id', wrap(async (c) => { await login.cancel(c.req.param('id')); return c.json({ ok: true }); }));
  return app;
}
