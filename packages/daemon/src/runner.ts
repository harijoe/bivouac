import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { LineSplitter, mergeConfig, parseProjectConfig, parseStreamLine, slugify, truncateOutput, type ProjectConfig, type Task, type Usage } from '@bivouac/shared';
import type { DaemonConfig } from './config.js';
import type { Store } from './db.js';
import { chownTree, createPullRequest, git, gitOk, parseGithubRepo } from './git.js';
import { previewUrl, traefikLabels } from './labels.js';
import { buildInitialPrompt, buildInstructionPrompt, buildRetryPrompt } from './prompt.js';
import type { Sandbox } from './sandbox.js';

export type SandboxFactory = (task: Task) => Sandbox;

interface Active { abort: AbortController; stop: boolean; done: Promise<void>; sandbox: Sandbox }

export const tokensOf = (u: Usage) => u.inputTokens + u.outputTokens + u.cacheCreationTokens;
const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens, costUsd: a.costUsd + b.costUsd,
});

export class TaskManager {
  private active = new Map<number, Active>();
  constructor(private store: Store, private cfg: DaemonConfig, private makeSandbox: SandboxFactory) {
    store.previewUrlFor = (project, id) => previewUrl(cfg, project, id);
  }

  // ---- paths
  taskDir(t: Pick<Task, 'projectName' | 'id'>) { return path.join(this.cfg.dataDir, 'projects', t.projectName, 'tasks', `t-${t.id}`); }
  hostWorkspace(t: Pick<Task, 'projectName' | 'id'>) { return path.join(this.taskDir(t), 'workspace'); }
  repoDir(t: Pick<Task, 'projectName' | 'id'>) { return path.join(this.hostWorkspace(t), 'repo'); }

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
      if (t.status === 'queued') this.store.setStatus(id, 'stopped');
      return;
    }
    a.stop = true;
    a.abort.abort();
    await a.done;
    await a.sandbox.stop();
  }

  async resume(id: number, instruction?: string) {
    const t = this.store.getTask(id);
    if (!t) throw new Error('no such task');
    if (this.active.has(id) || t.status === 'queued') throw new Error(`task is ${t.status}`);
    if (instruction) this.store.addInstruction(id, instruction);
    const project = this.store.getProject(t.projectId)!;
    const eff = mergeConfig(this.readRepoConfig(t), project.config);
    this.store.patchTask(id, { maxIterations: t.iteration + (eff.budget?.max_iterations ?? 10), error: null });
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
      if (n > 0 && !t.pushed) throw Object.assign(new Error(`branch ${t.branch} has ${n} unpushed commit(s)`), { code: 'UNPUSHED', unpushed: n });
    }
    await this.stop(id).catch(() => {});
    const sb = this.makeSandbox(t);
    // A non-root daemon (dev/CI) cannot delete files the container user created: let the container do it.
    if (typeof process.getuid === 'function' && process.getuid() !== 0 && (await sb.isRunning())) {
      await sb.exec(['sh', '-c', 'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; true']).catch(() => {});
    }
    await sb.destroy();
    try { rmSync(this.taskDir(t), { recursive: true, force: true }); } catch (e) {
      // only possible when the daemon is not root (dev/CI): files owned by the container user
      if (typeof process.getuid === 'function' && process.getuid() === 0) throw e;
    }
    this.store.deleteTask(id);
  }

  async unpushedCommits(t: Task): Promise<number> {
    const repo = this.repoDir(t);
    if (!existsSync(repo)) return 0;
    const r = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: repo });
    return r.code === 0 ? Number(r.stdout.trim()) : 0;
  }

  async push(id: number) {
    const t = this.store.getTask(id)!;
    const token = this.store.getProjectToken(t.projectId);
    const project = this.store.getProject(t.projectId)!;
    await gitOk(['push', '-u', 'origin', `${t.branch}:${t.branch}`], { cwd: this.repoDir(t), token, uid: this.cfg.taskUid });
    this.store.patchTask(id, { pushed: true });
    this.store.addEvent(id, 'system', { subtype: 'push', branch: t.branch, repo: project.repoUrl });
  }

  async openPr(id: number) {
    const t = this.store.getTask(id)!;
    const project = this.store.getProject(t.projectId)!;
    const token = this.store.getProjectToken(t.projectId);
    const gh = parseGithubRepo(project.repoUrl);
    if (!gh || !token) throw new Error('opening a PR needs a GitHub repository URL and a project token');
    if (!t.pushed) await this.push(id);
    const url = await createPullRequest({
      token, ...gh, head: t.branch, base: t.baseBranch, title: t.title,
      body: `${t.prompt}\n\n---\nStatus: ${t.status} after ${t.iteration} iteration(s). Created by bivouac task t-${t.id}.`,
    });
    this.store.patchTask(id, { prUrl: url });
    this.store.addEvent(id, 'system', { subtype: 'pr', url });
    return url;
  }

  async devLogs(id: number, lines = 200): Promise<string> {
    const t = this.store.getTask(id);
    if (!t) return '';
    const f = path.join(this.hostWorkspace(t), '.bivouac', 'dev.log');
    if (!existsSync(f)) return '';
    const text = readFileSync(f, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  }

  // ---- helpers
  private readRepoConfig(t: Task): ProjectConfig {
    const f = path.join(this.repoDir(t), 'bivouac.yml');
    if (!existsSync(f)) return {};
    try { return parseProjectConfig(readFileSync(f, 'utf8')); } catch (e: any) {
      this.store.addEvent(t.id, 'system', { subtype: 'config_warning', message: `bivouac.yml ignored: ${e.message}` });
      return {};
    }
  }
  private authEnv(): Record<string, string> {
    const oauth = this.store.getSecretSetting('claude_oauth_token') ?? this.cfg.oauthToken;
    const key = this.store.getSecretSetting('anthropic_api_key') ?? this.cfg.apiKey;
    return { ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth } : {}), ...(key ? { ANTHROPIC_API_KEY: key } : {}) };
  }
  /** Output sink: batches chunks into 'system' events so the dashboard can follow long commands. */
  private sink(id: number, label: string) {
    let buf = '';
    let all = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = () => { timer = null; if (buf) { this.store.addEvent(id, 'system', { subtype: 'output', label, text: truncateOutput(buf, 3000) }); buf = ''; } };
    return {
      push: (s: string) => { buf += s; all += s; if (all.length > 400_000) all = all.slice(-200_000); if (!timer) timer = setTimeout(flush, 500); },
      end: () => { if (timer) clearTimeout(timer); flush(); return all; },
    };
  }

  private async execute(id: number, a: Active) {
    let task = this.store.getTask(id)!;
    const project = this.store.getProject(task.projectId)!;
    const token = this.store.getProjectToken(project.id);
    const sb = a.sandbox;
    const hostWs = this.hostWorkspace(task);
    const repo = this.repoDir(task);
    this.store.setStatus(id, 'starting');

    // 1. clone on the host (token stays in the daemon) and create the task branch
    if (!existsSync(path.join(repo, '.git'))) {
      mkdirSync(hostWs, { recursive: true });
      await gitOk(['clone', '--quiet', project.repoUrl, repo], { token });
      await gitOk(['checkout', '-q', '-b', task.branch, `origin/${task.baseBranch}`], { cwd: repo });
      await gitOk(['config', 'user.name', 'bivouac agent'], { cwd: repo });
      await gitOk(['config', 'user.email', 'agent@bivouac.local'], { cwd: repo });
      this.store.addEvent(id, 'system', { subtype: 'clone', branch: task.branch, base: task.baseBranch });
    }
    const eff = mergeConfig(this.readRepoConfig(task), project.config);
    mkdirSync(path.join(hostWs, '.bivouac'), { recursive: true });
    chownTree(hostWs, this.cfg.taskUid);
    if (a.stop) return this.finishStopped(id);

    // 2. container + preview
    const dev = eff.dev!;
    const net = `${this.cfg.namePrefix}-task-${id}`;
    const pa = task.publicPreview ? this.store.getPreviewAuth(id) : null;
    await sb.start({
      taskId: id, project: project.name, hostWorkspace: hostWs, image: this.cfg.taskImage,
      env: { BIVOUAC_TASK_ID: String(id), BIVOUAC_BRANCH: task.branch, ...(task.previewUrl ? { BIVOUAC_PREVIEW_URL: task.previewUrl } : {}) },
      labels: traefikLabels(this.cfg, { taskId: id, project: project.name, port: dev.port, network: net, publicAuth: pa ? { user: pa.user, htpasswdHash: htpasswd(pa.pass) } : null }),
      cpus: eff.limits?.cpus, memory: eff.limits?.memory,
    });
    if (a.stop) return this.finishStopped(id);

    // 3. setup (once per workspace) and dev server
    const marker = path.join(hostWs, '.bivouac', 'setup.done');
    if (!existsSync(marker)) {
      if (eff.setup) {
        this.store.addEvent(id, 'system', { subtype: 'setup', command: eff.setup });
        const s = this.sink(id, 'setup');
        const code = await sb.exec(['bash', '-lc', eff.setup], { cwd: path.join(sb.ws, 'repo'), onData: s.push, signal: a.abort.signal });
        s.end();
        if (a.stop) return this.finishStopped(id);
        if (code !== 0) throw new Error(`setup command failed with exit code ${code}`);
      }
      mkdirSync(path.dirname(marker), { recursive: true });
      writeFileSync(marker, new Date().toISOString());
    }
    mkdirSync(path.join(hostWs, '.bivouac'), { recursive: true });
    writeFileSync(path.join(hostWs, '.bivouac', 'dev.json'), JSON.stringify({ command: dev.command, port: dev.port, cwd: path.join(sb.ws, 'repo') }));
    chownTree(path.join(hostWs, '.bivouac'), this.cfg.taskUid);

    // 4. agent loop
    const successCmd = task.successCommand;
    let failure: { output: string; exitCode: number } | null = null;
    for (;;) {
      task = this.store.getTask(id)!;
      if (task.iteration >= task.maxIterations) return void this.store.setStatus(id, 'max_iterations');
      const remaining = task.maxCostUsd - task.usage.costUsd;
      if (remaining <= 0.0001 || (task.maxTokens && tokensOf(task.usage) >= task.maxTokens)) return void this.store.setStatus(id, 'budget_exceeded');
      const iteration = task.iteration + 1;
      this.store.patchTask(id, { iteration });
      const instructions = this.store.takeInstructions(id);
      let prompt: string;
      if (!task.sessionId) {
        prompt = buildInitialPrompt({ prompt: task.prompt, branch: task.branch, baseBranch: task.baseBranch, previewUrl: task.previewUrl, devCommand: dev.command, devLogPath: path.join(sb.ws, '.bivouac', 'dev.log'), successCommand: successCmd, iteration, maxIterations: task.maxIterations });
        if (instructions.length) prompt += '\n\nAdditional instructions from the user:\n' + instructions.map((i) => `- ${i}`).join('\n');
      } else if (failure) {
        prompt = buildRetryPrompt({ checkOutput: failure.output, exitCode: failure.exitCode, successCommand: successCmd, instructions, iteration, maxIterations: task.maxIterations });
      } else {
        prompt = instructions.length ? buildInstructionPrompt(instructions) : `Continue working on the task. Make sure \`${successCmd}\` passes.`;
      }
      this.store.setStatus(id, 'running');
      const run = await this.runClaude(id, a, sb, prompt, task, remaining, iteration);
      if (a.stop) return this.finishStopped(id);
      if (run.outcome === 'budget') return void this.store.setStatus(id, 'budget_exceeded');
      if (run.outcome === 'failed') throw new Error(run.error);

      // 5. success check
      this.store.setStatus(id, 'checking');
      const s = this.sink(id, 'check');
      const code = await sb.exec(['bash', '-lc', successCmd], { cwd: path.join(sb.ws, 'repo'), onData: s.push, signal: a.abort.signal });
      const output = s.end();
      if (a.stop) return this.finishStopped(id);
      this.store.addEvent(id, 'check', { command: successCmd, exitCode: code, output: truncateOutput(output, 20000) });
      if (code === 0) return void this.store.setStatus(id, 'succeeded');
      failure = { output, exitCode: code };
      task = this.store.getTask(id)!;
      if (task.iteration >= task.maxIterations) return void this.store.setStatus(id, 'max_iterations');
      if (task.usage.costUsd >= task.maxCostUsd || (task.maxTokens && tokensOf(task.usage) >= task.maxTokens)) return void this.store.setStatus(id, 'budget_exceeded');
    }
  }

  private finishStopped(id: number) { this.store.setStatus(id, 'stopped'); }

  private async runClaude(id: number, a: Active, sb: Sandbox, prompt: string, task: Task, remaining: number, iteration: number):
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
        if (ev.kind !== 'rate_limit' || ev.data.status !== 'allowed') this.store.addEvent(id, ev.kind, ev.data, iteration);
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
    const args = [this.cfg.claudeBin, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--max-budget-usd', remaining.toFixed(4)];
    if (task.sessionId) args.push('--resume', task.sessionId);
    const code = await sb.exec(args, {
      cwd: path.join(sb.ws, 'repo'), env: this.authEnv(), signal: a.abort.signal,
      onData: (chunk, stream) => { if (stream === 'stdout') split.push(chunk).forEach(handle); else stderr.push(chunk); },
    });
    split.flush().forEach(handle);
    if (result) this.store.setUsage(id, addUsage(base, result.usage));
    if (a.stop) return { outcome: 'ok' };
    if (tokenAbort) return { outcome: 'budget' };
    if (result?.subtype === 'error_max_budget_usd') return { outcome: 'budget' };
    if (!result) return { outcome: 'failed', error: `claude exited with code ${code} without a result. ${truncateOutput(stderr.join(''), 1500)}` };
    if (result.isError && result.subtype !== 'error_max_turns') return { outcome: 'failed', error: `claude reported an error (${result.subtype}): ${truncateOutput(result.text, 1500)}` };
    return { outcome: 'ok' };
  }
}

/** Traefik basicauth accepts {SHA}-style hashes: user:{SHA}base64(sha1). */
import { createHash } from 'node:crypto';
function htpasswd(pass: string): string {
  return '{SHA}' + createHash('sha1').update(pass).digest('base64');
}
export { slugify };
