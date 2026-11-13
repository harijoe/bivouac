import Dockerode from 'dockerode';
import { spawn, type ChildProcess } from 'node:child_process';
import { chownSync, closeSync, cpSync, constants as fsc, copyFileSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { DEFAULT_SERVICE_CPUS, DEFAULT_SERVICE_MEMORY, SKILL_CATALOGUE, type SkillEntry, type DiffPatch, type DiffSummary, type GitMark, type ServiceConfig } from '@bivouac/shared';
import { chownTree, git, gitOk } from './git.js';
import { ensureSkill, type SkillResult } from './skills.js';
import { diffPatch, diffSummary, markState } from './gitdiff.js';
import { createArchive, extractArchive, removeArchive, snapshotFile, snapshotPaths } from './snapshot.js';

export interface SandboxSpec {
  taskId: number;
  project: string;
  env: Record<string, string>;
  cpus?: number;
  memory?: string;
  /** Sidecars to run next to the task. Services missing from this map are removed. */
  services?: Record<string, ServiceConfig>;
}
/** What Docker knows about one sidecar right now. */
export interface ServiceState {
  name: string;
  running: boolean;
  /** The kernel killed it for exceeding its memory limit (only meaningful while it is stopped). */
  oomKilled: boolean;
  exitCode: number | null;
  restartCount: number;
  startedAt: string;
  finishedAt: string;
  /** Memory limit in bytes (0 = none). */
  memoryLimit: number;
}
export interface TailWindow { text: string; start: number; end: number; size: number }
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
  push(o: { branch: string; token: string | null; url: string }): Promise<void>;
  /** Commits that exist only locally. */
  unpushed(): Promise<number>;
  /** Hash of the repository content (committed or not, ignored files excluded): changes whenever the code changes. */
  fingerprint(): Promise<string>;
  /**
   * A window of a text file below the workspace, cut on line boundaries: the lines that end at byte `before` (default: the
   * end of the file), at most `bytes` bytes of them. `start`/`end` are byte offsets, so a caller can page upwards
   * (`before = start`) or follow the file (`after`: only what was appended since that offset).
   */
  tail(rel: string, o?: { before?: number; after?: number; bytes?: number }): Promise<TailWindow>;
  /** Recent output of a sidecar service (stdout and stderr, each line prefixed with its timestamp by Docker). */
  serviceLogs(name: string, tail: number): Promise<string>;
  /** State of each sidecar (running, killed for memory…). Empty when the task has none. */
  serviceStates(): Promise<ServiceState[]>;
  /** Starts a stopped sidecar again (its data volume is kept). */
  restartService(name: string): Promise<void>;
  /** Identity of the image the task container runs from (part of the environment fingerprint). */
  imageId(): Promise<string>;
  /** Archives the git-ignored files of the repository (what `setup` installed) under `fp`. Null when there is nothing to keep. */
  snapshotCreate(fp: string, maxBytes?: number): Promise<{ bytes: number } | { tooLarge: number } | null>;
  /** Unpacks the snapshot `fp` into the repository. False when it is missing or damaged (nothing is left half-restored). */
  snapshotRestore(fp: string): Promise<boolean>;
  snapshotDelete(fp: string): Promise<void>;
  /** Removes every git-ignored file of the repository (used to start over when a restored snapshot turned out to be bad). */
  cleanIgnored(): Promise<void>;
  /** The HEAD and a snapshot commit of the working tree right now (see gitdiff.ts); null when there is no repository yet. */
  mark(): Promise<GitMark | null>;
  /** Files that differ between two marks (or `origin/<branch>`), with line counts. `heads` adds the commits between them. */
  diffSummary(from: string, to: string, heads?: { from: string | null; to: string | null }): Promise<DiffSummary>;
  /** A window of the patch of one file (both paths for a rename). */
  diffPatch(from: string, to: string, paths: string[], offset: number, limit: number): Promise<DiffPatch>;
  /** A binary file below the workspace (at most 8 MB). Returns null when absent or too large. */
  readBinary(rel: string): Promise<Buffer | null>;
  /** Puts catalogue skills (pinned, cached on the server) into the agent's `~/.claude/skills`; one failing skill never stops the others. */
  installSkills(names: string[]): Promise<SkillResult[]>;
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
  /** Where this project's snapshot archives live (shared by all its tasks). */
  protected abstract snapDir: string;
  protected abstract skillCache: string;
  protected catalogue: Record<string, SkillEntry> = SKILL_CATALOGUE;
  protected abstract placeSkills(dirs: string[]): Promise<void>;
  async installSkills(names: string[]): Promise<SkillResult[]> {
    const results: SkillResult[] = [];
    const staged: string[] = [];
    const stage = this.safe('.bivouac/skills');
    rmSync(stage, { recursive: true, force: true });
    for (const name of names) {
      const entry = this.catalogue[name];
      if (!entry) { results.push({ name, ok: false, error: 'not in the catalogue' }); continue; }
      try {
        const r = await ensureSkill(this.skillCache, name, entry);
        mkdirSync(stage, { recursive: true });
        cpSync(r.dir, path.join(stage, entry.dir), { recursive: true });
        staged.push(entry.dir);
        results.push({ name, ok: true, hooksRemoved: r.hooksRemoved });
      } catch (e: any) { results.push({ name, ok: false, error: String(e?.message ?? e).slice(0, 300) }); }
    }
    if (staged.length) {
      chownTree(stage, this.uid);
      try { await this.placeSkills(staged); } catch (e: any) { for (const r of results) if (r.ok) Object.assign(r, { ok: false, error: `could not install: ${String(e?.message ?? e).slice(0, 200)}` }); }
    }
    rmSync(stage, { recursive: true, force: true });
    return results;
  }
  async snapshotCreate(fp: string, maxBytes?: number) {
    const repo = this.safe('repo');
    const ls = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: repo, uid: this.uid, untrusted: true });
    if (ls.code !== 0) throw new Error(`git ls-files failed: ${ls.stderr.trim()}`);
    return createArchive(this.snapDir, fp, repo, snapshotPaths(ls.stdout.split('\0')), maxBytes);
  }
  async snapshotRestore(fp: string) {
    const repo = this.safe('repo');
    if (!existsSync(path.join(repo, '.git'))) return false;
    if (await extractArchive(this.snapDir, fp, repo)) return true;
    await this.cleanIgnored();
    return false;
  }
  async snapshotDelete(fp: string) { removeArchive(this.snapDir, fp); }
  async cleanIgnored() {
    const repo = this.safe('repo');
    if (existsSync(path.join(repo, '.git'))) await git(['clean', '-fdXq'], { cwd: repo, uid: this.uid, untrusted: true });
  }
  private safe(rel: string) {
    const p = path.resolve(this.hostWs, rel);
    if (p !== this.hostWs && !p.startsWith(this.hostWs + path.sep)) throw new Error('path escapes the workspace');
    return p;
  }
  private noLinks(p: string) {
    let cur = this.hostWs;
    for (const part of path.relative(this.hostWs, p).split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      let st;
      try { st = lstatSync(cur); } catch { return; }
      if (st.isSymbolicLink()) throw new Error('symbolic link inside the workspace');
    }
  }
  private openRead(rel: string) {
    const p = this.safe(rel);
    this.noLinks(p);
    try { return openSync(p, fsc.O_RDONLY | fsc.O_NOFOLLOW); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async readFile(rel: string) {
    const fd = this.openRead(rel);
    if (fd === null) return null;
    try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  }
  async readBinary(rel: string) {
    const fd = this.openRead(rel);
    if (fd === null) return null;
    try { return fstatSync(fd).size > 8 * 1024 * 1024 ? null : readFileSync(fd); } finally { closeSync(fd); }
  }
  async mark() {
    const repo = this.safe('repo');
    return existsSync(path.join(repo, '.git')) ? markState({ cwd: repo, uid: this.uid, untrusted: true }) : null;
  }
  async diffSummary(from: string, to: string, heads?: { from: string | null; to: string | null }) {
    return diffSummary({ cwd: this.safe('repo'), uid: this.uid, untrusted: true }, from, to, heads);
  }
  async diffPatch(from: string, to: string, paths: string[], offset: number, limit: number) {
    return diffPatch({ cwd: this.safe('repo'), uid: this.uid, untrusted: true }, from, to, paths, offset, limit);
  }
  async tail(rel: string, o: { before?: number; after?: number; bytes?: number } = {}): Promise<TailWindow> {
    const fd = this.openRead(rel);
    if (fd === null) return { text: '', start: 0, end: 0, size: 0 };
    const size = fstatSync(fd).size;
    const max = Math.min(Math.max(o.bytes ?? 65536, 1024), 1_000_000);
    let start: number, end: number;
    if (o.after !== undefined) { start = Math.min(o.after, size); end = Math.min(size, start + max); }
    else { end = Math.min(o.before ?? size, size); start = Math.max(0, end - max); }
    const buf = Buffer.alloc(end - start);
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    let text = buf.toString('utf8');
    // cut on line boundaries: drop a leading partial line when paging up (it belongs to the previous window), and a trailing
    // partial line when following (it is delivered once complete)
    if (o.after === undefined && start > 0) {
      const nl = text.indexOf('\n');
      if (nl < 0) { return { text: '', start: end, end, size }; }
      start += Buffer.byteLength(text.slice(0, nl + 1)); text = text.slice(nl + 1);
    }
    if (end < size || o.after !== undefined) {
      const nl = text.lastIndexOf('\n');
      if (nl < 0) return { text: '', start, end: start, size };
      end = start + Buffer.byteLength(text.slice(0, nl + 1)); text = text.slice(0, nl + 1);
    }
    return { text, start, end, size };
  }
  async writeFile(rel: string, content: string) {
    const p = this.safe(rel);
    this.noLinks(p);
    mkdirSync(path.dirname(p), { recursive: true });
    const fd = openSync(p, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NOFOLLOW, 0o644);
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
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
  async push(o: { branch: string; token: string | null; url: string }) {
    // --no-verify: the repository's own git hooks (pre-push often calls tools the executor does not have, such as pnpm) are
    // not the executor's business. The repository's checks run in the task, as the success command.
    await gitOk(['push', '--no-verify', '-u', 'origin', `${o.branch}:${o.branch}`], { cwd: this.safe('repo'), token: o.token, uid: this.uid, untrusted: true, url: o.url });
  }
  async unpushed() {
    const repo = this.safe('repo');
    if (!existsSync(repo)) return 0;
    const r = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: repo, uid: this.uid, untrusted: true });
    return r.code === 0 ? Number(r.stdout.trim()) : 0;
  }
  async fingerprint() {
    const repo = this.safe('repo');
    if (!existsSync(repo)) return '';
    // a throwaway index, so the agent's own staging area is never touched
    const idx = path.join(tmpdir(), `bv-fp-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: idx };
    try {
      if ((await git(['read-tree', 'HEAD'], { cwd: repo, env, uid: this.uid, untrusted: true })).code !== 0) return '';
      await git(['add', '-A', '--', '.', ':!.bivouac'], { cwd: repo, env, uid: this.uid, untrusted: true });
      const r = await git(['write-tree'], { cwd: repo, env, uid: this.uid, untrusted: true });
      return r.code === 0 ? r.stdout.trim() : '';
    } finally { rmSync(idx, { force: true }); }
  }
  protected removeWorkspace(taskDir: string) {
    try { rmSync(taskDir, { recursive: true, force: true }); } catch (e) {
      // only possible when the daemon is not root (dev/CI): files owned by the container user
      if (typeof process.getuid === 'function' && process.getuid() === 0) throw e;
    }
  }
}

/** Docker multiplexes stdout/stderr in 8-byte-headed frames when the container has no TTY. */
export function demuxDockerLogs(buf: Buffer): string {
  if (!Buffer.isBuffer(buf)) return String(buf ?? '');
  let out = '', i = 0;
  while (i + 8 <= buf.length && buf[i] <= 2 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0) {
    const len = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  return i === 0 ? buf.toString('utf8') : out;
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
  protected snapDir: string;
  protected skillCache: string;
  private taskDir: string;
  private container: Dockerode.Container | null = null;
  private name = '';
  constructor(private docker: Dockerode, private opts: { namePrefix: string; taskId: number; project: string; dataDir: string; image: string; traefikContainer: string; uid: number }) {
    super();
    this.name = `${opts.namePrefix}-task-${opts.taskId}`;
    this.container = docker.getContainer(this.name);
    this.taskDir = path.join(opts.dataDir, 'projects', opts.project, 'tasks', `t-${opts.taskId}`);
    this.hostWs = path.join(this.taskDir, 'workspace');
    this.snapDir = path.join(opts.dataDir, 'projects', opts.project, 'snapshots');
    this.skillCache = path.join(opts.dataDir, 'skills');
    this.uid = opts.uid;
  }
  protected async placeSkills(dirs: string[]) {
    const script = 'mkdir -p "$HOME/.claude/skills" && for d in "$@"; do rm -rf "$HOME/.claude/skills/$d" && cp -r "/workspace/.bivouac/skills/$d" "$HOME/.claude/skills/$d"; done';
    let err = '';
    const code = await this.exec(['sh', '-c', script, 'sh', ...dirs], { onData: (c, s) => { if (s === 'stderr') err += c; } });
    if (code !== 0) throw new Error(err.trim() || `exit code ${code}`);
  }
  get networkName() { return this.name; }
  async imageId() { return (await this.docker.getImage(this.opts.image).inspect().catch(() => null))?.Id ?? this.opts.image; }

  async start(spec: SandboxSpec) {
    mkdirSync(this.hostWs, { recursive: true });
    try { chownSync(this.hostWs, this.opts.uid, this.opts.uid); } catch { /* not root (tests) */ }
    const labels = { 'bivouac.managed': 'true', 'bivouac.task': String(spec.taskId) };
    // Fresh per-task network; Traefik joins it so previews are routed without tasks seeing each other.
    // The bridge has a predictable name (bvt<id>) so the host firewall (firewall.sh) can cut its access to the host.
    const bridge = `bvt${spec.taskId}`;
    let net = await this.docker.getNetwork(this.name).inspect().catch(() => null);
    if (net && net.Options?.['com.docker.network.bridge.name'] !== bridge) {
      // created by an older version: recreate it so that the firewall covers it
      await this.removeContainers();
      await this.docker.getNetwork(this.name).disconnect({ Container: this.opts.traefikContainer, Force: true }).catch(() => {});
      await this.docker.getNetwork(this.name).remove().catch(() => {});
      net = null;
    }
    if (!net) {
      await this.docker.createNetwork({ Name: this.name, Labels: { 'bivouac.managed': 'true' }, Options: { 'com.docker.network.bridge.name': bridge } });
    }
    await this.syncServices(spec);
    // tool versions (mise) are installed into a cache shared by the tasks of one project: only the first one downloads
    const cache = `${this.opts.namePrefix}-mise-${this.opts.project}`;
    await this.docker.createVolume({ Name: cache, Labels: { 'bivouac.managed': 'true', 'bivouac.cache': 'mise', 'bivouac.project': this.opts.project } }).catch(() => {});
    try { await this.container!.inspect().then(async (i) => { if (!i.State.Running) await this.container!.start(); }); }
    catch {
      const c = await this.docker.createContainer({
        name: this.name, Image: this.opts.image, Labels: labels,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        HostConfig: {
          Binds: [`${this.hostWs}:/workspace`, `${cache}:/mise`],
          NetworkMode: this.name,
          NanoCpus: spec.cpus ? Math.round(spec.cpus * 1e9) : undefined,
          Memory: spec.memory ? parseMemory(spec.memory) : undefined,
          MemorySwap: spec.memory ? parseMemory(spec.memory) : undefined,
          PidsLimit: 4096,
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

  /**
   * Unpacks the snapshot inside the task container, so every file belongs to the task user whatever user the daemon runs as
   * (a host-side extraction by a non-root daemon leaves files the container user cannot chmod). The archive is hard-linked
   * into the workspace for the duration of the extraction (copied when that is not possible).
   */
  async snapshotRestore(fp: string) {
    const src = snapshotFile(this.snapDir, fp);
    if (!existsSync(src) || !existsSync(path.join(this.hostWs, 'repo', '.git'))) return false;
    const dst = path.join(this.hostWs, '.bivouac', 'restore.tar');
    mkdirSync(path.dirname(dst), { recursive: true });
    rmSync(dst, { force: true });
    try { linkSync(src, dst); } catch { copyFileSync(src, dst); }
    let code = 1;
    try { code = await this.exec(['tar', '-xf', '/workspace/.bivouac/restore.tar', '-C', '/workspace/repo']); }
    finally { rmSync(dst, { force: true }); }
    if (code === 0) return true;
    await this.cleanIgnored();
    return false;
  }

  private svcName(n: string) { return `${this.name}-svc-${n}`; }
  private async removeContainers() {
    await this.container!.remove({ force: true }).catch(() => {});
    for (const c of await this.docker.listContainers({ all: true, filters: { label: [`bivouac.task=${this.opts.taskId}`] } })) await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
  }
  /** Starts the declared sidecars (own instances, on the task network, reachable by name) and removes the others. */
  private async syncServices(spec: SandboxSpec) {
    const want = spec.services ?? {};
    const labels = (n: string) => ({ 'bivouac.managed': 'true', 'bivouac.task': String(spec.taskId), 'bivouac.service': n });
    for (const c of await this.docker.listContainers({ all: true, filters: { label: [`bivouac.task=${spec.taskId}`] } })) {
      const n = c.Labels['bivouac.service'];
      if (n && !want[n]) {
        await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
        await this.docker.getVolume(`${this.svcName(n)}-data`).remove().catch(() => {});
      }
    }
    for (const [n, sc] of Object.entries(want)) {
      const c = this.docker.getContainer(this.svcName(n));
      const info = await c.inspect().catch(() => null);
      const memory = parseMemory(sc.memory ?? DEFAULT_SERVICE_MEMORY), nanoCpus = Math.round((sc.cpus ?? DEFAULT_SERVICE_CPUS) * 1e9);
      if (info && info.Config.Image !== sc.image) { await c.remove({ force: true }).catch(() => {}); }
      else if (info) {
        // limits changed in bivouac.yml (or by a newer default): applied to the running container, or by recreating it
        // (the data volume is kept) when Docker refuses, for example because the new limit is below what it uses now
        if (info.HostConfig.Memory !== memory || info.HostConfig.NanoCpus !== nanoCpus) {
          try { await c.update({ Memory: memory, MemorySwap: memory, NanoCpus: nanoCpus } as never); }
          catch { await c.remove({ force: true }).catch(() => {}); await this.createService(spec, n, sc, labels(n), memory, nanoCpus); continue; }
        }
        if (!info.State.Running) await c.start();
        continue;
      }
      await this.createService(spec, n, sc, labels(n), memory, nanoCpus);
    }
  }
  private async createService(spec: SandboxSpec, n: string, sc: ServiceConfig, labels: Record<string, string>, memory: number, nanoCpus: number) {
    await this.pullIfMissing(sc.image);
    const vol = `${this.svcName(n)}-data`;
    if (sc.volume) await this.docker.createVolume({ Name: vol, Labels: labels }).catch(() => {});
    const created = await this.docker.createContainer({
      name: this.svcName(n), Image: sc.image, Labels: labels,
      Env: Object.entries(sc.env ?? {}).map(([k, v]) => `${k}=${v}`),
      NetworkingConfig: { EndpointsConfig: { [this.name]: { Aliases: [n] } } },
      HostConfig: {
        NetworkMode: this.name,
        Binds: sc.volume ? [`${vol}:${sc.volume}`] : undefined,
        NanoCpus: nanoCpus,
        // no swap: a service over its limit is killed (and reported) instead of crawling
        Memory: memory, MemorySwap: memory,
        PidsLimit: 512,
        RestartPolicy: { Name: 'no' },
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['NET_RAW'],
      },
    });
    await created.start();
    void spec;
  }
  async serviceStates(): Promise<ServiceState[]> {
    const out: ServiceState[] = [];
    for (const c of await this.docker.listContainers({ all: true, filters: { label: [`bivouac.task=${this.opts.taskId}`, 'bivouac.service'] } }).catch(() => [])) {
      const i = await this.docker.getContainer(c.Id).inspect().catch(() => null);
      if (!i) continue;
      out.push({ name: c.Labels['bivouac.service'], running: i.State.Running, oomKilled: !!i.State.OOMKilled, exitCode: i.State.Running ? null : i.State.ExitCode, restartCount: i.RestartCount ?? 0, startedAt: i.State.StartedAt, finishedAt: i.State.FinishedAt, memoryLimit: i.HostConfig.Memory ?? 0 });
    }
    return out;
  }
  async restartService(name: string) {
    if (!/^[a-z0-9-]{1,30}$/.test(name)) return;
    await this.docker.getContainer(this.svcName(name)).start().catch((e: any) => { if (e?.statusCode !== 304) throw e; });
  }
  private async pullIfMissing(image: string) {
    if (await this.docker.getImage(image).inspect().then(() => true, () => false)) return;
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, st: NodeJS.ReadableStream) => {
        if (err) return reject(new Error(`cannot pull the image ${image}: ${err.message}`));
        this.docker.modem.followProgress(st, (e: Error | null) => (e ? reject(new Error(`cannot pull the image ${image}: ${e.message}`)) : resolve()));
      });
    });
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
    out.setEncoding('utf8'); err.setEncoding('utf8');
    out.on('data', (b: string) => o.onData?.(b, 'stdout'));
    err.on('data', (b: string) => o.onData?.(b, 'stderr'));
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

  async serviceLogs(name: string, tail: number): Promise<string> {
    if (!/^[a-z0-9-]{1,30}$/.test(name)) return '';
    const c = this.docker.getContainer(this.svcName(name));
    const buf = (await c.logs({ stdout: true, stderr: true, timestamps: true, tail: Math.min(Math.max(tail, 1), 20000) }).catch(() => Buffer.alloc(0))) as unknown as Buffer;
    return demuxDockerLogs(buf);
  }
  async isRunning() {
    try { return (await this.container!.inspect()).State.Running; } catch { return false; }
  }
  async stop() {
    try { await this.container!.stop({ t: 5 }); } catch { /* already stopped / absent */ }
    for (const c of await this.docker.listContainers({ filters: { label: [`bivouac.task=${this.opts.taskId}`, 'bivouac.service'] } }).catch(() => [])) {
      await this.docker.getContainer(c.Id).stop({ t: 5 }).catch(() => {});
    }
  }
  async destroy() {
    // A non-root executor (dev/CI) cannot delete files the container user created: let the container do it.
    if (typeof process.getuid === 'function' && process.getuid() !== 0 && (await this.isRunning())) {
      await this.exec(['sh', '-c', 'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; true']).catch(() => {});
    }
    try { await this.docker.getNetwork(this.name).disconnect({ Container: this.opts.traefikContainer, Force: true }); } catch { /* not connected */ }
    try { await this.container!.remove({ force: true }); } catch { /* absent */ }
    for (const c of await this.docker.listContainers({ all: true, filters: { label: [`bivouac.task=${this.opts.taskId}`] } }).catch(() => [])) {
      await this.docker.getContainer(c.Id).remove({ force: true, v: true }).catch(() => {});
    }
    for (const v of (await this.docker.listVolumes({ filters: { label: [`bivouac.task=${this.opts.taskId}`] } }).catch(() => ({ Volumes: [] as { Name: string }[] }))).Volumes ?? []) {
      await this.docker.getVolume(v.Name).remove({ force: true }).catch(() => {});
    }
    try { await this.docker.getNetwork(this.name).remove(); } catch { /* absent */ }
    this.removeWorkspace(this.taskDir);
  }
}

/** Runs everything as local child processes in a directory. Used by unit tests only. */
export class LocalSandbox extends HostWorkspace implements Sandbox {
  ws: string;
  protected hostWs: string;
  protected uid = 1000;
  protected snapDir: string;
  protected skillCache: string;
  private sup: ChildProcess | null = null;
  /** Where the agent's `~/.claude/skills` would be (tests read it). */
  get skillsHome() { return path.join(this.hostWs, '.claude-home', '.claude', 'skills'); }
  protected async placeSkills(dirs: string[]) {
    for (const d of dirs) { rmSync(path.join(this.skillsHome, d), { recursive: true, force: true }); cpSync(path.join(this.hostWs, '.bivouac', 'skills', d), path.join(this.skillsHome, d), { recursive: true }); }
  }
  setCatalogue(c: Record<string, SkillEntry>) { this.catalogue = c; }
  constructor(dir: string, private supervisorPath?: string, snapDir?: string, skillCache?: string) {
    super(); this.ws = dir; this.hostWs = dir; mkdirSync(dir, { recursive: true });
    // <data>/projects/<project>/tasks/t-N/workspace -> <data>/projects/<project>/snapshots
    this.snapDir = snapDir ?? path.resolve(dir, '..', '..', '..', 'snapshots');
    this.skillCache = skillCache ?? path.resolve(dir, '..', '..', '..', '..', 'skills');
  }
  async imageId() { return 'local'; }
  async start() {
    if (this.supervisorPath && !this.sup) {
      this.sup = spawn('node', [this.supervisorPath], { env: { ...process.env, BIVOUAC_STATE_DIR: `${this.ws}/.bivouac` }, stdio: 'ignore' });
    }
  }
  exec(cmd: string[], o: ExecOpts = {}): Promise<number> {
    return new Promise((resolve) => {
      const p = spawn(cmd[0], cmd.slice(1), { cwd: o.cwd ?? this.ws, env: { ...process.env, ...o.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
      p.stdout.on('data', (b) => o.onData?.(b, 'stdout'));
      p.stderr.on('data', (b) => o.onData?.(b, 'stderr'));
      const kill = () => { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } };
      if (o.signal?.aborted) kill(); else o.signal?.addEventListener('abort', kill, { once: true });
      p.on('error', () => resolve(127));
      p.on('close', (code, sig) => resolve(code ?? (sig ? 143 : 1)));
    });
  }
  async serviceLogs() { return ''; }
  async serviceStates(): Promise<ServiceState[]> { return []; }
  async restartService() { /* no services in local sandboxes */ }
  async isRunning() { return true; }
  async stop() { this.sup?.kill('SIGTERM'); this.sup = null; }
  async destroy() { await this.stop(); this.removeWorkspace(path.dirname(this.hostWs)); }
}
