import path from 'node:path';
import { LineSplitter, mergeConfig, parseProjectConfig, parseStreamLine, resolvePorts, slugify, truncateOutput, type ProjectConfig, type Task, type Usage } from '@bivouac/shared';
import type { DaemonConfig } from './config.js';
import type { Store } from './db.js';
import { createPullRequest, parseGithubRepo } from './git.js';
import { aliasUrl, previewUrl } from './routes.js';
import { buildInitialPrompt, buildInstructionPrompt, buildRetryPrompt, describeEnvironment } from './prompt.js';
import type { Sandbox } from './sandbox.js';
import type { Project } from '@bivouac/shared';
import { claudeEnv, resolveClaude } from './accounts.js';
import { ServiceWatch } from './service-watch.js';
import { redactValues as redactText } from './agent-tools.js';
import { prepareTooling, redactData, type PreparedTooling } from './tooling.js';
import { Shots } from './shots.js';
import { fingerprint as envFingerprint, LOCK_FILES, removeArchive, SNAPSHOT_KEEP, SNAPSHOT_MAX_BYTES } from './snapshot.js';
import { describeRuntime, detectRuntime, miseConfig, RUNTIME_FILES, runtimeKey, type RuntimeSpec } from './runtime.js';

export type SandboxFactory = (task: Task) => Sandbox;
/** Returns a credential for git / GitHub API calls on a project's repository (never given to a container). */
export type RepoTokenProvider = (project: Project, access: 'read' | 'write') => Promise<string | null>;

interface Active { abort: AbortController; stop: boolean; done: Promise<void>; sandbox: Sandbox }

export const tokensOf = (u: Usage) => u.inputTokens + u.outputTokens + u.cacheCreationTokens;
const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens, costUsd: a.costUsd + b.costUsd,
});

export class TaskManager {
  private active = new Map<number, Active>();
  readonly shots: Shots;
  /** Deletes a snapshot archive without a task at hand (a project's rebuild); the web service replaces it with a call to the executor. */
  removeSnapshotFile: (project: string, fp: string) => Promise<void>;
  constructor(private store: Store, private cfg: DaemonConfig, private makeSandbox: SandboxFactory, private repoToken: RepoTokenProvider = async (p) => store.getProjectToken(p.id), private fetchImpl?: typeof fetch) {
    this.shots = new Shots(store, cfg.dataDir);
    this.removeSnapshotFile = async (project, fp) => removeArchive(path.join(cfg.dataDir, 'projects', project, 'snapshots'), fp);
    store.previewUrlFor = (project, name, portName) => previewUrl(cfg, project, name, portName);
    store.aliasUrlFor = (alias, portName) => aliasUrl(cfg, alias, portName);
  }

  // ---- lifecycle
  /** Called on daemon boot: interrupted runs become `stopped`, queued ones restart. */
  recover() {
    for (const id of this.store.nonTerminalTaskIds()) this.store.setStatus(id, 'stopped', 'daemon restarted while the task was running; resume it to continue');
    this.pump();
  }
  isActive(id: number) { return this.active.has(id); }

  enqueue(id: number) {
    this.store.setStatus(id, 'queued');
    this.pump();
  }
  private pump() {
    for (const id of this.store.queuedTaskIds()) {
      if (this.active.size >= this.cfg.maxParallel) return;
      if (this.active.has(id)) continue;
      this.launch(id);
    }
  }
  private launch(id: number) {
    const task = this.store.getTask(id)!;
    const abort = new AbortController();
    const entry: Active = { abort, stop: false, sandbox: this.makeSandbox(task), done: Promise.resolve() };
    this.active.set(id, entry);
    entry.done = this.execute(id, entry)
      .catch((e) => { this.store.addEvent(id, 'error', { message: String(e?.message ?? e) }); this.store.setStatus(id, entry.stop ? 'stopped' : 'failed', String(e?.message ?? e)); })
      .finally(() => { this.active.delete(id); this.pump(); });
  }
  /** Resolves when no run is active for the task (tests). */
  async settled(id: number) { await this.active.get(id)?.done; }

  async stop(id: number) {
    const a = this.active.get(id);
    const t = this.store.getTask(id);
    if (!t) throw new Error('no such task');
    if (!a) {
      // queued, or left in a running state by a crash: nothing is running for it, so it is simply stopped
      if (['queued', 'starting', 'running', 'checking'].includes(t.status)) this.store.setStatus(id, 'stopped');
      return;
    }
    a.stop = true;
    a.abort.abort();
    await a.done;
    await a.sandbox.stop();
  }

  /**
   * Continues a task. When it has used all its attempts and the caller did not raise the limit, it gets a fresh allowance
   * (the configured number of attempts on top of those already made); otherwise the limit set by the owner stays.
   */
  /**
   * Continues a task. When it has used all its attempts and the caller did not raise the limit, it gets a fresh allowance
   * (the configured number of attempts on top of those already made); otherwise the limit set by the owner stays.
   */
  async resume(id: number, instruction?: string) {
    const t = this.store.getTask(id);
    if (!t) throw new Error('no such task');
    if (this.active.has(id) || t.status === 'queued') throw new Error(`task is ${t.status}`);
    if (instruction) this.store.addInstruction(id, instruction);
    let maxIterations = t.maxIterations;
    if (t.iteration >= t.maxIterations) {
      const project = this.store.getProject(t.projectId)!;
      const eff = mergeConfig(await this.readRepoConfig(t), project.config);
      maxIterations = t.iteration + (eff.budget?.max_iterations ?? 10);
      this.store.addEvent(id, 'system', { subtype: 'limits_changed', by: 'bivouac', changes: [{ field: 'maxIterations', from: t.maxIterations, to: maxIterations }], message: `Attempt limit raised from ${t.maxIterations} to ${maxIterations} to continue.` });
    }
    this.store.patchTask(id, { maxIterations, error: null });
    this.enqueue(id);
  }

  /** User instruction: queued while a run is active (injected at next --resume), otherwise resumes the task. */
  async instruct(id: number, text: string) {
    const t = this.store.getTask(id);
    if (!t) throw new Error('no such task');
    if (this.active.has(id) || t.status === 'queued') { this.store.addInstruction(id, text); return { queued: true }; }
    await this.resume(id, text);
    return { queued: false };
  }

  async destroy(id: number, force: boolean) {
    const t = this.store.getTask(id);
    if (!t) return;
    if (!force) {
      const n = await this.unpushedCommits(t);
      if (n > 0) throw Object.assign(new Error(`branch ${t.branch} has ${n} unpushed commit(s)`), { code: 'UNPUSHED', unpushed: n });
    }
    await this.stop(id).catch(() => {});
    await this.makeSandbox(t).destroy();
    this.shots.purge(id);
    this.store.deleteTask(id);
  }

  async unpushedCommits(t: Task): Promise<number> {
    return this.makeSandbox(t).unpushed();
  }

  async push(id: number) {
    const t = this.store.getTask(id)!;
    const project = this.store.getProject(t.projectId)!;
    const token = await this.repoToken(project, 'write');
    await this.makeSandbox(t).push({ branch: t.branch, token, url: project.repoUrl });
    this.store.patchTask(id, { pushed: true });
    this.store.addEvent(id, 'system', { subtype: 'push', branch: t.branch, repo: project.repoUrl });
  }

  async openPr(id: number) {
    const t = this.store.getTask(id)!;
    const project = this.store.getProject(t.projectId)!;
    const gh = parseGithubRepo(project.repoUrl);
    if (!gh) throw new Error('Project is not connected to GitHub: only GitHub repositories support pull requests.');
    const token = await this.repoToken(project, 'write');
    if (!token) throw new Error('Project is not connected to GitHub: no credential is available for this repository.');
    if (!t.pushed || (await this.unpushedCommits(t)) > 0) await this.push(id);
    const url = await createPullRequest({
      token, ...gh, head: t.branch, base: t.baseBranch, title: t.title,
      body: `${t.prompt}\n\n---\nStatus: ${t.status} after ${t.iteration} iteration(s). Created by bivouac task ${t.name}.`, fetchImpl: this.fetchImpl,
    });
    this.store.patchTask(id, { prUrl: url });
    this.store.addEvent(id, 'system', { subtype: 'pr', url });
    return url;
  }

  /** The sandbox of a task (read-only uses: logs). */
  sandboxFor(t: Task): Sandbox { return this.makeSandbox(t); }

  async devLogs(id: number, lines = 200): Promise<string> {
    const t = this.store.getTask(id);
    if (!t) return '';
    const text = await this.makeSandbox(t).readFile('.bivouac/dev.log').catch(() => null);
    return text ? text.split('\n').slice(-lines).join('\n') : '';
  }

  // ---- helpers
  private async readRepoConfig(t: Task): Promise<ProjectConfig> {
    const text = await this.makeSandbox(t).readFile('repo/bivouac.yml').catch(() => null);
    if (!text) return {};
    try { return parseProjectConfig(text); } catch (e: any) {
      this.store.addEvent(t.id, 'system', { subtype: 'config_warning', message: `bivouac.yml ignored: ${e.message}` });
      return {};
    }
  }
  /**
   * Reads bivouac.yml from the task's working copy and publishes the ports and services it declares.
   * An invalid file never interrupts the task: the last valid configuration stays in use and the error is reported.
   */
  private async loadConfig(t: Task, project: Project, sb: Sandbox, announce: boolean): Promise<ProjectConfig> {
    const prev = this.store.getLiveConfig(t.id);
    const text = await sb.readFile('repo/bivouac.yml').catch(() => null);
    let repo: ProjectConfig = prev?.repo ?? {};
    let error: string | null = null;
    if (text === null) repo = {};
    else try { repo = parseProjectConfig(text); } catch (e: any) { error = String(e?.message ?? e); }
    const eff = mergeConfig(repo, project.config);
    const ports = resolvePorts(eff);
    const live = { ports, services: eff.services ?? {}, error, repo };
    if (announce && error && error !== prev?.error) this.store.addEvent(t.id, 'system', { subtype: 'config_warning', message: `bivouac.yml is invalid, the previous configuration is kept: ${error}` });
    if (announce && !error && prev && (JSON.stringify(prev.ports) !== JSON.stringify(ports) || JSON.stringify(prev.services) !== JSON.stringify(live.services))) {
      this.store.addEvent(t.id, 'system', { subtype: 'config_changed', ports: ports.map((p) => p.name), services: Object.keys(live.services) });
    }
    this.store.patchTask(t.id, { liveConfig: live, ...(ports[0] ? { devPort: ports[0].port } : {}) });
    return eff;
  }
  /** The account is resolved at every agent session: a project's change of account applies to the next attempt. */
  private claudeFor(projectId: number) { return resolveClaude(this.store, this.cfg, projectId); }
  /** Output sink: batches chunks into 'system' events so the dashboard can follow long commands. */
  private sink(id: number, label: string) {
    let buf = '';
    let all = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = () => { timer = null; if (buf) { this.store.addEvent(id, 'system', { subtype: 'output', label, text: truncateOutput(buf, 60000) }); buf = ''; } };
    return {
      push: (s: string) => { buf += s; all += s; if (all.length > 400_000) all = all.slice(-200_000); if (!timer) timer = setTimeout(flush, 500); },
      end: () => { if (timer) clearTimeout(timer); flush(); return all; },
    };
  }

  private async execute(id: number, a: Active) {
    const task = this.store.getTask(id)!;
    const project = this.store.getProject(task.projectId)!;
    const sb = a.sandbox;
    this.store.setStatus(id, 'starting');
    this.store.setPreview(id, null);

    // 1. clone on the host (credentials stay out of the container) and create the task branch
    const token = await this.repoToken(project, 'read');
    if (await sb.prepareRepo({ repoUrl: project.repoUrl, token, branch: task.branch, base: task.baseBranch })) {
      this.store.addEvent(id, 'system', { subtype: 'clone', branch: task.branch, base: task.baseBranch });
    }
    const eff = await this.loadConfig(task, project, sb, false);
    if (a.stop) return this.finishStopped(id);

    // 2. container, sidecars and preview routes (served by Traefik from the database, see routes.ts)
    const startSandbox = () => sb.start({
      taskId: id, project: project.name,
      env: { BIVOUAC_TASK_ID: String(id), BIVOUAC_BRANCH: task.branch, ...(task.previewUrl ? { BIVOUAC_PREVIEW_URL: task.previewUrl } : {}) },
      cpus: eff.limits?.cpus, memory: eff.limits?.memory, services: eff.services ?? {},
    });
    await startSandbox();
    const watch = new ServiceWatch(this.store, id, sb);
    await watch.baseline();
    watch.start();
    try {
      return await this.runLoop(id, a, task, project, sb, eff, startSandbox, watch);
    } finally { watch.stop(); }
  }

  private async runLoop(id: number, a: Active, task0: Task, project: Project, sb: Sandbox, eff0: ProjectConfig, startSandbox: () => Promise<void>, watch: ServiceWatch) {
    let task = task0, eff = eff0;
    let runtime = await this.prepareRuntime(id, sb, eff, a);
    if (a.stop) return this.finishStopped(id);
    let servicesKey = JSON.stringify(eff.services ?? {});
    let skillsKey = '';
    let toolingKey = '';
    if (a.stop) return this.finishStopped(id);

    // 3. setup (once per workspace) and dev server
    if ((await sb.readFile('.bivouac/setup.done')) === null) {
      if (eff.setup) await this.runSetup(id, a, project, sb, eff, runtime);
      if (a.stop) return this.finishStopped(id);
      await sb.writeFile('.bivouac/setup.done', new Date().toISOString());
    }
    let devKey = '';
    const writeDev = async () => {
      const hp = eff.preview?.health;
      const d = { command: eff.dev!.command, port: resolvePorts(eff)[0]?.port ?? 0, cwd: path.join(sb.ws, 'repo'), runtime: runtimeKey(runtime), healthPort: hp?.port ?? undefined, healthPath: hp?.path ?? undefined };
      const key = JSON.stringify(d);
      if (key !== devKey) { await sb.writeFile('.bivouac/dev.json', key); devKey = key; }
    };
    await writeDev();
    const dev = eff.dev!;

    // 4. agent loop
    let failure: { output: string; exitCode: number } | null = null;
    let lastCheck: { output: string; fingerprint: string } | null = null;
    // the attempt whose git end-mark is still to be recorded (every way out of the loop passes through the `finally`)
    let open: number | null = null;
    try {
    for (;;) {
      if (open !== null) { await this.markAttempt(id, sb, open, 'end'); open = null; }
      task = this.store.getTask(id)!;
      if (task.iteration >= task.maxIterations) return void this.store.setStatus(id, 'max_iterations');
      const remaining = task.maxCostUsd - task.usage.costUsd;
      if (remaining <= 0.0001 || (task.maxTokens && tokensOf(task.usage) >= task.maxTokens)) return void this.store.setStatus(id, 'budget_exceeded');
      const iteration = task.iteration + 1;
      // limits and success command can be changed while the task exists: read at the start of every attempt
      const successCmd = task.successCommand;
      this.store.patchTask(id, { iteration });
      await this.markAttempt(id, sb, iteration, 'begin');
      open = iteration;
      // the agent may have edited bivouac.yml: new ports and services take effect now
      eff = await this.loadConfig(task, project, sb, true);
      runtime = await this.prepareRuntime(id, sb, eff, a);
      if (a.stop) return this.finishStopped(id);
      if (JSON.stringify(eff.services ?? {}) !== servicesKey) { servicesKey = JSON.stringify(eff.services ?? {}); skillsKey = ''; await startSandbox(); await watch.baseline(); }
      await writeDev();
      const wantedSkills = JSON.stringify(eff.skills ?? []);
      const tools = await prepareTooling({ store: this.store, project, sb, eff, installSkills: skillsKey !== wantedSkills });
      skillsKey = wantedSkills;
      this.store.setTooling(id, tools.tooling);
      const newToolingKey = JSON.stringify(tools.tooling);
      if (newToolingKey !== toolingKey) {
        toolingKey = newToolingKey;
        this.store.addEvent(id, 'system', { subtype: 'tooling', mcp: tools.tooling.mcp.map((m) => `${m.name}${m.status === 'skipped' ? ' (skipped)' : ''}`), skills: tools.tooling.skills.map((x) => x.name), message: `The agent has ${tools.tooling.mcp.filter((m) => m.status !== 'skipped').length} MCP server(s) and ${tools.tooling.skills.length} skill(s).` });
        for (const n of tools.notes) { this.store.addNotice(id, n); this.store.addEvent(id, 'system', { subtype: 'tooling_warning', message: n }); }
      }

      const env = describeEnvironment({ aliasUrl: this.store.getTask(id)!.aliasUrl, ports: this.store.getTask(id)!.ports, services: Object.entries(eff.services ?? {}).map(([name, v]) => ({ name, image: v.image })), configError: this.store.getTask(id)!.configError });
      const instructions = this.store.takeInstructions(id);
      let prompt: string;
      if (!task.sessionId) {
        prompt = buildInitialPrompt({ aliasUrl: this.store.getTask(id)!.aliasUrl, ports: this.store.getTask(id)!.ports, services: Object.entries(eff.services ?? {}).map(([name, v]) => ({ name, image: v.image })), configError: this.store.getTask(id)!.configError, prompt: task.prompt, branch: task.branch, baseBranch: task.baseBranch, previewUrl: task.previewUrl, runtime: describeRuntime(runtime), devCommand: dev.command, devLogPath: path.join(sb.ws, '.bivouac', 'dev.log'), successCommand: successCmd, iteration, maxIterations: task.maxIterations });
        if (instructions.length) prompt += '\n\nAdditional instructions from the user:\n' + instructions.map((i) => `- ${i}`).join('\n');
      } else if (failure) {
        prompt = buildRetryPrompt({ checkOutput: failure.output, exitCode: failure.exitCode, successCommand: successCmd, instructions, iteration, maxIterations: task.maxIterations, env });
      } else {
        prompt = instructions.length ? buildInstructionPrompt(instructions, env) : `Continue working on the task. Make sure \`${successCmd}\` passes.${env.length ? '\n' + env.join('\n') : ''}`;
      }
      await watch.check();
      const notices = [...watch.takeNotices(), ...this.store.takeNotices(id)];
      if (notices.length) prompt += '\n\nNotes from bivouac about this task (services, preview):\n' + notices.map((n) => `- ${n}`).join('\n');
      this.store.setStatus(id, 'running');
      const run = await this.runClaude(id, a, sb, prompt, task, remaining, iteration, tools);
      await watch.check();
      if (a.stop) return this.finishStopped(id);
      if (run.outcome === 'budget') return void this.store.setStatus(id, 'budget_exceeded');
      if (run.outcome === 'failed') throw new Error(run.error);

      // the agent can stop by itself when it cannot go on (see the system prompt)
      const blocked = await this.takeBlocked(sb);
      if (blocked) {
        this.store.addEvent(id, 'system', { subtype: 'blocked', reason: blocked });
        await this.captureShots(id, a, sb, eff, task, iteration, null);
        return void this.store.setStatus(id, 'blocked', blocked);
      }

      // 5. success check
      this.store.setStatus(id, 'checking');
      const s = this.sink(id, 'check');
      const code = await sb.exec(['bash', '-lc', successCmd], { cwd: path.join(sb.ws, 'repo'), onData: s.push, signal: a.abort.signal });
      const output = s.end();
      if (a.stop) return this.finishStopped(id);
      this.store.addEvent(id, 'check', { command: successCmd, exitCode: code, output: truncateOutput(output, 20000) });
      await this.captureShots(id, a, sb, eff, task, iteration, code === 0);
      if (code === 0) return void this.store.setStatus(id, 'succeeded');
      failure = { output, exitCode: code };
      // same failure, same code as the previous attempt: another attempt would burn tokens for nothing
      const fingerprint = await sb.fingerprint().catch(() => '');
      if (lastCheck && fingerprint && lastCheck.fingerprint === fingerprint && lastCheck.output === output) {
        const msg = `The success command failed twice in a row with the same output and no change to the code, so bivouac stopped the task instead of trying again. Last output:\n${truncateOutput(output, 1500)}`;
        this.store.addEvent(id, 'system', { subtype: 'stuck', command: successCmd, exitCode: code });
        return void this.store.setStatus(id, 'stuck', msg);
      }
      lastCheck = { output, fingerprint };
      task = this.store.getTask(id)!;
      if (task.iteration >= task.maxIterations) return void this.store.setStatus(id, 'max_iterations');
      if (task.usage.costUsd >= task.maxCostUsd || (task.maxTokens && tokensOf(task.usage) >= task.maxTokens)) return void this.store.setStatus(id, 'budget_exceeded');
    }
    } finally {
      if (open !== null) await this.markAttempt(id, sb, open, 'end');
    }
  }

  /**
   * `setup`, started from the environment snapshot of the project when one matches (same lock files, setup command, tool versions
   * and task image). `setup` always runs, on top of what the snapshot restored: it stays correct when the snapshot is stale, and a
   * snapshot that makes it fail is thrown away and setup runs again from scratch. A successful setup without a matching snapshot
   * leaves a new one for the next task. Snapshots never fail a task: any problem with them is reported and ignored.
   */
  private async runSetup(id: number, a: Active, project: Project, sb: Sandbox, eff: ProjectConfig, runtime: RuntimeSpec) {
    const setup = eff.setup!;
    const runOnce = async () => {
      this.store.addEvent(id, 'system', { subtype: 'setup', command: setup });
      const s = this.sink(id, 'setup');
      const code = await sb.exec(['bash', '-lc', setup], { cwd: path.join(sb.ws, 'repo'), onData: s.push, signal: a.abort.signal });
      s.end();
      return code;
    };
    let fp: string | null = null, restored = false, snap = null as ReturnType<Store['findSnapshot']>;
    try {
      const files: Record<string, string | null> = {};
      await Promise.all(LOCK_FILES.map(async (f) => { files[f] = await sb.readFile(`repo/${f}`).catch(() => null); }));
      fp = envFingerprint({ files, setup, runtime: runtimeKey(runtime), image: await sb.imageId() });
      if (fp) {
        this.store.setLastFingerprint(project.id, fp);
        snap = this.store.findSnapshot(project.id, fp);
        if (snap) {
          const t0 = Date.now();
          restored = await sb.snapshotRestore(fp);
          if (restored) {
            this.store.touchSnapshot(snap.id);
            this.store.addEvent(id, 'system', { subtype: 'snapshot_restored', bytes: snap.bytes, ms: Date.now() - t0, message: `Started from the environment snapshot of ${project.name} (${Math.round(snap.bytes / 1024 ** 2)} MB, restored in ${Math.max(1, Math.round((Date.now() - t0) / 1000))} s); setup runs on top of it.` });
          } else {
            this.store.deleteSnapshot(snap.id);
            this.store.addEvent(id, 'system', { subtype: 'snapshot_missing', message: 'The environment snapshot could not be restored (missing or damaged); setup runs from scratch.' });
          }
        }
      }
    } catch (e: any) {
      this.store.addEvent(id, 'system', { subtype: 'snapshot_error', message: `Environment snapshot skipped: ${String(e?.message ?? e)}` });
    }
    let code = await runOnce();
    if (a.stop) return;
    if (code !== 0 && restored && fp) {
      // the snapshot may be the cause: forget it, clean the ignored files and run setup once more from scratch
      this.store.addEvent(id, 'system', { subtype: 'snapshot_discarded', message: 'Setup failed on top of the snapshot; the snapshot was discarded and setup runs again from scratch.' });
      const old = this.store.findSnapshot(project.id, fp);
      if (old) this.store.deleteSnapshot(old.id);
      await sb.snapshotDelete(fp).catch(() => {});
      await sb.cleanIgnored().catch(() => {});
      restored = false;
      code = await runOnce();
      if (a.stop) return;
    }
    if (code !== 0) throw new Error(`setup command failed with exit code ${code}`);
    if (fp && !restored) await this.saveSnapshot(id, project, sb, fp);
  }

  private async saveSnapshot(id: number, project: Project, sb: Sandbox, fp: string) {
    try {
      const t0 = Date.now();
      const r = await sb.snapshotCreate(fp, SNAPSHOT_MAX_BYTES);
      if (!r) return;
      if ('tooLarge' in r) { this.store.addEvent(id, 'system', { subtype: 'snapshot_skipped', message: `The environment is ${Math.round(r.tooLarge / 1024 ** 3 * 10) / 10} GB: too large to keep as a snapshot (limit ${SNAPSHOT_MAX_BYTES / 1024 ** 3} GB).` }); return; }
      this.store.addSnapshot(project.id, fp, r.bytes);
      for (const old of this.store.snapshotsOverLimit(project.id, SNAPSHOT_KEEP)) { this.store.deleteSnapshot(old.id); await sb.snapshotDelete(old.fingerprint).catch(() => {}); }
      this.store.addEvent(id, 'system', { subtype: 'snapshot_created', bytes: r.bytes, ms: Date.now() - t0, message: `Environment snapshot saved for the next tasks of ${project.name} (${Math.round(r.bytes / 1024 ** 2)} MB, ${Math.max(1, Math.round((Date.now() - t0) / 1000))} s).` });
    } catch (e: any) {
      this.store.addEvent(id, 'system', { subtype: 'snapshot_error', message: `The environment snapshot could not be saved: ${String(e?.message ?? e)}` });
    }
  }

  /** Photographs the preview at the end of an attempt. Bounded in time, and a failure only shows up in the history. */
  private async captureShots(id: number, a: Active, sb: Sandbox, eff: ProjectConfig, task: Task, attempt: number, checkPassed: boolean | null) {
    if (a.stop) return;
    // unit tests have no browser: they opt in with BIVOUAC_SHOT_SCRIPT
    if (this.cfg.testMode && !process.env.BIVOUAC_SHOT_SCRIPT) return;
    const t = this.store.getTask(id) ?? task;
    const r = await this.shots.capture(t, sb, eff, attempt, checkPassed, a.abort.signal).catch((e) => ({ ok: false, count: 0, problems: 0, message: String(e?.message ?? e) }));
    this.store.addEvent(id, 'system', { subtype: 'screenshots', ok: r.ok, count: r.count, problems: r.problems, message: r.message }, attempt);
  }

  /** Records the state of the repository at the start / end of an attempt, for the per-attempt diff. Never fails an attempt. */
  private async markAttempt(id: number, sb: Sandbox, attempt: number, when: 'begin' | 'end') {
    try {
      const m = await sb.mark();
      if (when === 'begin') this.store.beginAttemptGit(id, attempt, m); else this.store.endAttemptGit(id, attempt, m);
    } catch (e: any) {
      this.store.addEvent(id, 'system', { subtype: 'mark_failed', message: `Could not record the state of the repository (${when} of attempt ${attempt}): ${String(e?.message ?? e)}` }, attempt);
    }
  }

  /**
   * Finds the tool versions the repository wants (see runtime.ts), writes them to the mise configuration of the task and
   * installs what is missing. Runs at the start of the task and of every agent session, so a `runtime:` the agent added
   * to bivouac.yml takes effect on its next session. Throws when an install fails, with mise's output.
   */
  private async prepareRuntime(id: number, sb: Sandbox, eff: ProjectConfig, a: Active): Promise<RuntimeSpec> {
    const files: Record<string, string | null> = {};
    await Promise.all(RUNTIME_FILES.map(async (f) => { files[f] = await sb.readFile(`repo/${f}`).catch(() => null); }));
    const spec = detectRuntime(files, eff.runtime);
    const key = runtimeKey(spec);
    if (key === (await sb.readFile('.bivouac/runtime.key').catch(() => null))) return spec;
    await sb.writeFile('.bivouac/mise.toml', miseConfig(spec));
    if (Object.keys(spec.tools).length) {
      this.store.addEvent(id, 'system', { subtype: 'runtime', tools: spec.tools, sources: spec.sources });
      const s = this.sink(id, 'runtime');
      const code = await sb.exec(['bash', '-lc', 'mise install'], { cwd: sb.ws, onData: s.push, signal: a.abort.signal });
      const out = s.end();
      if (a.stop) return spec;
      if (code !== 0) throw new Error(`Could not install the tool versions this project needs (${describeRuntime(spec)}). If the version exists, check its name; otherwise set another one under \`runtime:\` in bivouac.yml. Output: ${truncateOutput(out, 1200)}`);
    }
    await sb.writeFile('.bivouac/runtime.key', key);
    return spec;
  }

  /** `.bivouac/blocked.md`, written by the agent when it cannot continue: its content is the reason. Consumed once. */
  private async takeBlocked(sb: Sandbox): Promise<string | null> {
    const text = await sb.readFile('.bivouac/blocked.md').catch(() => null);
    if (text === null) return null;
    await sb.writeFile('.bivouac/blocked.md', '').catch(() => {});
    return text.trim() ? truncateOutput(text.trim(), 3000) : null;
  }

  private finishStopped(id: number) { this.store.setStatus(id, 'stopped'); }

  /** The CLI says which servers it could start: the page shows that rather than what was only configured. */
  private noteMcpStatus(id: number, servers: { name: string; status: string }[]) {
    const cur = this.store.getTask(id)?.tooling;
    if (!cur) return;
    const mcp = cur.mcp.map((m) => {
      const s = servers.find((x) => x.name === m.name);
      if (!s || m.status === 'skipped') return m;
      return { ...m, status: s.status === 'connected' ? ('connected' as const) : ('failed' as const), ...(s.status === 'connected' ? {} : { note: `the CLI reported: ${s.status}` }) };
    });
    this.store.setTooling(id, { ...cur, mcp });
    for (const m of mcp) if (m.status === 'failed') this.store.addNotice(id, `MCP server "${m.name}" did not start (${m.note ?? 'failed'}); work without it.`);
  }

  private async runClaude(id: number, a: Active, sb: Sandbox, prompt: string, task: Task, remaining: number, iteration: number, tools: PreparedTooling):
    Promise<{ outcome: 'ok' | 'budget' | 'failed'; error?: string }> {
    const base = task.usage;
    const live = new Map<string, Omit<Usage, 'costUsd'>>();
    let result: ReturnType<typeof parseStreamLine>[number]['result'] | undefined;
    let tokenAbort = false;
    const stderr: string[] = [];
    const split = new LineSplitter();
    const handle = (line: string) => {
      for (const ev of parseStreamLine(line)) {
        if (ev.sessionId && this.store.getTask(id)!.sessionId !== ev.sessionId) this.store.patchTask(id, { sessionId: ev.sessionId });
        if (ev.kind === 'system' && ev.data?.subtype === 'init' && Array.isArray(ev.data.mcpServers)) this.noteMcpStatus(id, ev.data.mcpServers);
        if (ev.kind !== 'rate_limit' || ev.data.status !== 'allowed') this.store.addEvent(id, ev.kind, redactData(ev.data, tools.secretValues) as any, iteration);
        if (ev.messageUsage) {
          live.set(ev.messageUsage.messageId, ev.messageUsage.usage);
          const sum = [...live.values()].reduce((x, y) => ({ inputTokens: x.inputTokens + y.inputTokens, outputTokens: x.outputTokens + y.outputTokens, cacheReadTokens: x.cacheReadTokens + y.cacheReadTokens, cacheCreationTokens: x.cacheCreationTokens + y.cacheCreationTokens }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
          const total = addUsage(base, { ...sum, costUsd: 0 });
          this.store.setUsage(id, total);
          if (task.maxTokens && tokensOf(total) >= task.maxTokens && !tokenAbort) { tokenAbort = true; a.abort.abort(); }
        }
        if (ev.result) result = ev.result;
      }
    };
    const account = this.claudeFor(task.projectId);
    if (account && task.accountName !== account.name) this.store.patchTask(id, { accountName: account.name });
    const accountNote = account ? ` (Claude account “${account.name}”)` : '';
    const args = [this.cfg.claudeBin, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--max-budget-usd', remaining.toFixed(4)];
    args.push(...tools.args);
    if (task.sessionId) args.push('--resume', task.sessionId);
    const code = await sb.exec(args, {
      cwd: path.join(sb.ws, 'repo'), env: { ...claudeEnv(account), ...tools.env }, signal: a.abort.signal,
      onData: (chunk, stream) => { if (stream === 'stdout') split.push(chunk).forEach(handle); else stderr.push(chunk); },
    });
    split.flush().forEach(handle);
    if (result) this.store.setUsage(id, addUsage(base, result.usage));
    if (a.stop) return { outcome: 'ok' };
    if (tokenAbort) return { outcome: 'budget' };
    if (result?.subtype === 'error_max_budget_usd') return { outcome: 'budget' };
    if (!result) return { outcome: 'failed', error: redactText(`claude${accountNote} exited with code ${code} without a result. ${truncateOutput(stderr.join(''), 1500)}`, tools.secretValues) };
    if (result.isError && result.subtype !== 'error_max_turns') return { outcome: 'failed', error: `claude${accountNote} reported an error (${result.subtype}): ${redactText(truncateOutput(result.text, 1500), tools.secretValues)}` };
    return { outcome: 'ok' };
  }
}

export { slugify };
