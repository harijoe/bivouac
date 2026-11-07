import Dockerode from 'dockerode';
import { spawn, type ChildProcess } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { chownTree, git, gitOk } from './git.js';

export interface SandboxSpec {
  taskId: number;
  project: string;
  env: Record<string, string>;
  cpus?: number;
  memory?: string;
}
export interface PrepareOpts { repoUrl: string; token: string | null; branch: string; base: string }
export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  onData?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
}
/** Where a task's code runs. Implemented by Docker (real) and Local (unit tests). */
export interface Sandbox {
  /** Workspace path as seen by processes inside the sandbox. */
  readonly ws: string;
  /** Clones the repository (the token never enters the container) and creates the task branch. Returns true when it cloned. */
  prepareRepo(o: PrepareOpts): Promise<boolean>;
  start(spec: SandboxSpec): Promise<void>;
  push(o: { branch: string; token: string | null }): Promise<void>;
  /** Commits that exist only locally. */
  unpushed(): Promise<number>;
  /** Files below the workspace (`repo/…`, `.bivouac/…`). Returns null when absent. */
  readFile(rel: string): Promise<string | null>;
  writeFile(rel: string, content: string): Promise<void>;
  /** Runs a command; resolves with its exit code (143 if aborted). */
  exec(cmd: string[], opts?: ExecOpts): Promise<number>;
  isRunning(): Promise<boolean>;
  /** Stop the container but keep the workspace. */
  stop(): Promise<void>;
  /** Remove container, network and the workspace on disk. */
  destroy(): Promise<void>;
}

/** Shared by the Docker and local sandboxes: everything that only touches the host-side workspace. */
abstract class HostWorkspace {
  protected abstract hostWs: string;
  protected abstract uid: number;
  private safe(rel: string) {
    const p = path.resolve(this.hostWs, rel);
    if (p !== this.hostWs && !p.startsWith(this.hostWs + path.sep)) throw new Error('path escapes the workspace');
    return p;
  }
  async readFile(rel: string) {
    const p = this.safe(rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  async writeFile(rel: string, content: string) {
    const p = this.safe(rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    chownTree(path.dirname(p), this.uid);
  }
  async prepareRepo(o: PrepareOpts): Promise<boolean> {
    const repo = this.safe('repo');
    mkdirSync(this.hostWs, { recursive: true });
    let cloned = false;
    if (!existsSync(path.join(repo, '.git'))) {
      await gitOk(['clone', '--quiet', o.repoUrl, repo], { token: o.token });
      await gitOk(['checkout', '-q', '-b', o.branch, `origin/${o.base}`], { cwd: repo });
      await gitOk(['config', 'user.name', 'bivouac agent'], { cwd: repo });
      await gitOk(['config', 'user.email', 'agent@bivouac.local'], { cwd: repo });
      cloned = true;
    }
    // The state directory must exist and belong to the container user before the supervisor writes in it.
    mkdirSync(path.join(this.hostWs, '.bivouac'), { recursive: true });
    chownTree(this.hostWs, this.uid);
    return cloned;
  }
  async push(o: { branch: string; token: string | null }) {
    await gitOk(['push', '-u', 'origin', `${o.branch}:${o.branch}`], { cwd: this.safe('repo'), token: o.token, uid: this.uid });
  }
  async unpushed() {
    const repo = this.safe('repo');
    if (!existsSync(repo)) return 0;
    const r = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: repo });
    return r.code === 0 ? Number(r.stdout.trim()) : 0;
  }
  protected removeWorkspace(taskDir: string) {
    try { rmSync(taskDir, { recursive: true, force: true }); } catch (e) {
      // only possible when the daemon is not root (dev/CI): files owned by the container user
      if (typeof process.getuid === 'function' && process.getuid() === 0) throw e;
    }
  }
}

export const parseMemory = (m: string): number => {
  const mm = /^(\d+(?:\.\d+)?)([kmg]?)$/i.exec(m.trim());
  if (!mm) throw new Error(`bad memory limit: ${m}`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[mm[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
  return Math.round(Number(mm[1]) * mult);
};

export class DockerSandbox extends HostWorkspace implements Sandbox {
  readonly ws = '/workspace';
  protected hostWs: string;
  protected uid: number;
  private taskDir: string;
  private container: Dockerode.Container | null = null;
  private name = '';
  constructor(private docker: Dockerode, private opts: { namePrefix: string; taskId: number; project: string; dataDir: string; image: string; traefikContainer: string; uid: number }) {
    super();
    this.name = `${opts.namePrefix}-task-${opts.taskId}`;
    this.container = docker.getContainer(this.name);
    this.taskDir = path.join(opts.dataDir, 'projects', opts.project, 'tasks', `t-${opts.taskId}`);
    this.hostWs = path.join(this.taskDir, 'workspace');
    this.uid = opts.uid;
  }
  get networkName() { return this.name; }

  async start(spec: SandboxSpec) {
    mkdirSync(this.hostWs, { recursive: true });
    try { chownSync(this.hostWs, this.opts.uid, this.opts.uid); } catch { /* not root (tests) */ }
    const labels = { 'bivouac.managed': 'true', 'bivouac.task': String(spec.taskId) };
    // Fresh per-task network; Traefik joins it so previews are routed without tasks seeing each other.
    try { await this.docker.getNetwork(this.name).inspect(); } catch {
      await this.docker.createNetwork({ Name: this.name, Labels: { 'bivouac.managed': 'true' } });
    }
    try { await this.container!.inspect().then(async (i) => { if (!i.State.Running) await this.container!.start(); }); }
    catch {
      const c = await this.docker.createContainer({
        name: this.name, Image: this.opts.image, Labels: labels,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        HostConfig: {
          Binds: [`${this.hostWs}:/workspace`],
          NetworkMode: this.name,
          NanoCpus: spec.cpus ? Math.round(spec.cpus * 1e9) : undefined,
          Memory: spec.memory ? parseMemory(spec.memory) : undefined,
          RestartPolicy: { Name: 'no' },
          SecurityOpt: ['no-new-privileges:true'],
          CapDrop: ['NET_RAW'],
        },
      });
      this.container = c;
      await c.start();
    }
    try { await this.docker.getNetwork(this.name).connect({ Container: this.opts.traefikContainer }); }
    catch (e: any) { if (!/already exists|No such container|not found|already/i.test(String(e?.message))) throw e; }
  }

  async exec(cmd: string[], o: ExecOpts = {}): Promise<number> {
    const c = this.container!;
    const pidfile = `/tmp/bv-${randomUUID()}.pid`;
    const wrapped = ['sh', '-c', 'echo $$ > "$0"; exec "$@"', pidfile, ...cmd];
    const exec = await c.exec({
      Cmd: wrapped, AttachStdout: true, AttachStderr: true, WorkingDir: o.cwd ?? this.ws,
      Env: Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`),
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new PassThrough(), err = new PassThrough();
    out.on('data', (b) => o.onData?.(b.toString('utf8'), 'stdout'));
    err.on('data', (b) => o.onData?.(b.toString('utf8'), 'stderr'));
    this.docker.modem.demuxStream(stream, out, err);
    let aborted = false;
    const onAbort = async () => {
      aborted = true;
      const kill = async (sig: string) => {
        const k = await c.exec({ Cmd: ['sh', '-c', `kill -${sig} $(cat ${pidfile}) 2>/dev/null; pkill -${sig} -P $(cat ${pidfile}) 2>/dev/null; true`], AttachStdout: true });
        await (await k.start({})).resume?.();
      };
      await kill('TERM').catch(() => {});
      setTimeout(() => kill('KILL').catch(() => {}), 5000).unref();
    };
    if (o.signal?.aborted) await onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
    await new Promise<void>((res) => { stream.on('end', res); stream.on('close', res); stream.on('error', res); });
    o.signal?.removeEventListener('abort', onAbort);
    // exit code may lag slightly behind stream end
    for (let i = 0; i < 50; i++) {
      const info = await exec.inspect();
      if (!info.Running) return aborted ? 143 : (info.ExitCode ?? 1);
      await new Promise((r) => setTimeout(r, 100));
    }
    return aborted ? 143 : 1;
  }

  async isRunning() {
    try { return (await this.container!.inspect()).State.Running; } catch { return false; }
  }
  async stop() {
    try { await this.container!.stop({ t: 5 }); } catch { /* already stopped / absent */ }
  }
  async destroy() {
    // A non-root executor (dev/CI) cannot delete files the container user created: let the container do it.
    if (typeof process.getuid === 'function' && process.getuid() !== 0 && (await this.isRunning())) {
      await this.exec(['sh', '-c', 'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; true']).catch(() => {});
    }
    try { await this.docker.getNetwork(this.name).disconnect({ Container: this.opts.traefikContainer, Force: true }); } catch { /* not connected */ }
    try { await this.container!.remove({ force: true }); } catch { /* absent */ }
    try { await this.docker.getNetwork(this.name).remove(); } catch { /* absent */ }
    this.removeWorkspace(this.taskDir);
  }
}

/** Runs everything as local child processes in a directory. Used by unit tests only. */
export class LocalSandbox extends HostWorkspace implements Sandbox {
  ws: string;
  protected hostWs: string;
  protected uid = 1000;
  private sup: ChildProcess | null = null;
  constructor(dir: string, private supervisorPath?: string) { super(); this.ws = dir; this.hostWs = dir; mkdirSync(dir, { recursive: true }); }
  async start() {
    if (this.supervisorPath && !this.sup) {
      this.sup = spawn('node', [this.supervisorPath], { env: { ...process.env, BIVOUAC_STATE_DIR: `${this.ws}/.bivouac` }, stdio: 'ignore' });
    }
  }
  exec(cmd: string[], o: ExecOpts = {}): Promise<number> {
    return new Promise((resolve) => {
      const p = spawn(cmd[0], cmd.slice(1), { cwd: o.cwd ?? this.ws, env: { ...process.env, ...o.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      p.stdout.on('data', (b) => o.onData?.(b.toString(), 'stdout'));
      p.stderr.on('data', (b) => o.onData?.(b.toString(), 'stderr'));
      const kill = () => { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } };
      if (o.signal?.aborted) kill(); else o.signal?.addEventListener('abort', kill, { once: true });
      p.on('error', () => resolve(127));
      p.on('close', (code, sig) => resolve(code ?? (sig ? 143 : 1)));
    });
  }
  async isRunning() { return true; }
  async stop() { this.sup?.kill('SIGTERM'); this.sup = null; }
  async destroy() { await this.stop(); this.removeWorkspace(path.dirname(this.hostWs)); }
}
