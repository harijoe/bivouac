import { mergeConfig, parseProjectConfig, slugify, validateTaskName, type Project, type Task } from '@bivouac/shared';
import type { DaemonConfig } from './config.js';
import { baseUrl } from './config.js';
import type { Auth } from './auth.js';
import type { Store } from './db.js';
import { detectDefaultBranch, fetchRepoFile } from './git.js';
import type { GithubApp } from './githubapp.js';
import type { Previews, ShareDuration } from './preview.js';
import type { TaskManager } from './runner.js';
import { TOKEN_LIFETIME_DAYS } from './claude.js';

/** An error whose message is safe and useful to show to a person or to a model (it says what to do next). */
export class UserError extends Error {
  constructor(message: string, public code = 'invalid', public status: 400 | 404 | 409 | 412 | 502 = 400) { super(message); }
}

export interface Actor { kind: 'user' | 'mcp' | 'system'; label: string }

export interface TaskSummary {
  id: number; name: string; project: string; title: string; status: string; iteration: number; maxIterations: number;
  costUsd: number; maxCostUsd: number; tokens: number; previewUrl: string | null; dashboardUrl: string; prUrl: string | null; pushed: boolean;
  branch: string; error: string | null; createdAt: string; finishedAt: string | null;
}

/** Everything the dashboard and the MCP server can do. One place for validation, messages and the audit trail. */
export class Service {
  constructor(public store: Store, public cfg: DaemonConfig, public mgr: TaskManager, public auth: Auth, public gh: GithubApp, public previews: Previews) {}

  // ---- links
  base() { return baseUrl(this.cfg); }
  dashboardUrl(path = '') { return this.base() + path; }
  taskUrl(t: Pick<Task, 'projectName' | 'name'>) { return this.dashboardUrl(`/projects/${t.projectName}/${t.name}`); }

  // ---- Claude credentials
  claudeStatus(): { connected: boolean; kind: 'oauth' | 'apikey' | null; expiresAt: string | null; expired: boolean } {
    const oauth = this.store.getSecretSetting('claude_oauth_token') ?? this.cfg.oauthToken;
    const key = this.store.getSecretSetting('anthropic_api_key') ?? this.cfg.apiKey;
    const at = this.store.getSetting('claude_token_at');
    const expiresAt = oauth && at ? new Date(Date.parse(at) + TOKEN_LIFETIME_DAYS * 86400_000).toISOString() : null;
    const expired = !!expiresAt && Date.parse(expiresAt) < Date.now();
    return { connected: !!(oauth || key), kind: oauth ? 'oauth' : key ? 'apikey' : null, expiresAt, expired };
  }
  private assertClaude() {
    const s = this.claudeStatus();
    const link = this.dashboardUrl('/settings');
    if (!s.connected) throw new UserError(`Claude is not connected. Ask the user to connect Claude in the bivouac dashboard, then retry. Link: ${link}`, 'claude_not_connected', 412);
    if (s.expired) throw new UserError(`The Claude token has expired. Ask the user to reconnect Claude in the dashboard, then retry. Link: ${link}`, 'claude_expired', 412);
  }

  // ---- projects
  listProjects() {
    return this.store.listProjects().map((p) => ({ ...p, totals: this.store.totals(p.id) }));
  }
  resolveProject(ref: string | number): Project {
    const p = typeof ref === 'number' || /^\d+$/.test(String(ref)) ? this.store.getProject(Number(ref)) : this.store.getProjectByName(String(ref));
    if (!p) {
      const names = this.store.listProjects().map((x) => x.name).join(', ') || 'none yet';
      throw new UserError(`Unknown project "${ref}". Known projects: ${names}. Use list_projects to see them. New projects are added by the user in the dashboard.`, 'unknown_project', 404);
    }
    return p;
  }
  /** Adds a repository that the GitHub App can see. */
  async addGithubProject(o: { fullName: string; name?: string }, actor: Actor): Promise<Project> {
    if (!this.gh.configured) throw new UserError('GitHub is not connected. Connect it in Settings first.', 'github_not_connected', 412);
    const repos = await this.gh.listRepos();
    const repo = repos.find((r) => r.fullName.toLowerCase() === o.fullName.toLowerCase());
    if (!repo) throw new UserError(`Repository ${o.fullName} is not available to the GitHub App. Give the app access to it on GitHub (Settings > GitHub > Choose repositories).`, 'repo_not_installed', 404);
    const name = slugify(o.name ?? repo.fullName.split('/')[1], 24);
    if (this.store.getProjectByName(name)) throw new UserError(`A project named "${name}" already exists. Pick another name.`, 'name_taken', 409);
    const p = this.store.createProject({ name, repoUrl: `https://github.com/${repo.fullName}.git`, defaultBranch: repo.defaultBranch, githubRepo: repo.fullName, installationId: repo.installationId });
    this.auth.audit(actor.label, 'project_added', { project: name, repo: repo.fullName });
    return p;
  }
  /** Advanced: a fine-grained personal access token instead of the GitHub App. */
  async addTokenProject(o: { repoUrl: string; token: string | null; name?: string; defaultBranch?: string }, actor: Actor): Promise<Project> {
    const repoUrl = o.repoUrl.trim();
    if (!repoUrl) throw new UserError('repoUrl is required', 'invalid');
    const name = slugify(o.name ?? repoUrl.split('/').pop()!.replace(/\.git$/, ''), 24);
    if (this.store.getProjectByName(name)) throw new UserError(`A project named "${name}" already exists. Pick another name.`, 'name_taken', 409);
    let branch: string;
    try { branch = o.defaultBranch || (await detectDefaultBranch(repoUrl, o.token)); } catch (e: any) { throw new UserError(`Cannot access the repository: ${e.message}`, 'repo_unreachable'); }
    const gh = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
    const p = this.store.createProject({ name, repoUrl, defaultBranch: branch, githubToken: o.token, githubRepo: gh?.[1] ?? null });
    this.auth.audit(actor.label, 'project_added', { project: name, repo: repoUrl, withToken: !!o.token });
    return p;
  }
  /** Credential used for git and the GitHub API on one project. Installation tokens are scoped to the project's repository only. */
  repoToken = async (p: Project, access: 'read' | 'write'): Promise<string | null> => {
    const own = this.store.getProjectToken(p.id);
    if (own) return own;
    if (p.installationId && p.githubRepo) return this.gh.installationToken(p.installationId, { repo: p.githubRepo, access });
    return null;
  };

  // ---- tasks
  summary(t: Task): TaskSummary {
    return {
      id: t.id, name: t.name, project: t.projectName, title: t.title, status: t.status, iteration: t.iteration, maxIterations: t.maxIterations,
      costUsd: t.usage.costUsd, maxCostUsd: t.maxCostUsd, tokens: t.usage.inputTokens + t.usage.outputTokens + t.usage.cacheCreationTokens,
      previewUrl: t.previewUrl, dashboardUrl: this.taskUrl(t), prUrl: t.prUrl, pushed: t.pushed, branch: t.branch, error: t.error, createdAt: t.createdAt, finishedAt: t.finishedAt,
    };
  }
  resolveTask(projectRef: string | number | undefined, taskRef: string | number): Task {
    let t: Task | null = null;
    if (projectRef !== undefined && projectRef !== '') {
      const p = this.resolveProject(projectRef);
      t = typeof taskRef === 'number' ? this.store.getTask(taskRef) : this.store.getTaskByName(p.id, String(taskRef));
      if (t && t.projectId !== p.id) t = null;
    } else if (typeof taskRef === 'number' || /^\d+$/.test(String(taskRef))) t = this.store.getTask(Number(taskRef));
    if (!t) throw new UserError(`Unknown task "${taskRef}"${projectRef ? ` in project "${projectRef}"` : ''}. Use list_tasks to see the existing tasks.`, 'unknown_task', 404);
    return t;
  }

  async createTask(o: {
    project: string | number; name: string; prompt: string; successCommand?: string; maxIterations?: number; maxCostUsd?: number; maxTokens?: number;
    baseBranch?: string; idempotencyKey?: string;
  }, actor: Actor): Promise<{ task: Task; created: boolean }> {
    const p = this.resolveProject(o.project);
    if (o.idempotencyKey) {
      const row = this.store.db.prepare('SELECT task_id FROM idempotency WHERE key=? AND project_id=?').get(o.idempotencyKey, p.id) as any;
      const prev = row ? this.store.getTask(row.task_id) : null;
      if (prev) return { task: prev, created: false };
    }
    const nameErr = validateTaskName(o.name);
    if (nameErr) throw new UserError(nameErr, 'invalid_name');
    if (this.store.taskNameTaken(p.id, o.name)) throw new UserError(`The name "${o.name}" is already used in project "${p.name}". Propose another name (for example "${o.name.slice(0, 34)}-2").`, 'name_taken', 409);
    const prompt = String(o.prompt ?? '').trim();
    if (!prompt) throw new UserError('prompt is required: describe what the agent must build or fix.', 'invalid');
    this.assertClaude();
    const baseBranch = o.baseBranch || p.defaultBranch;
    let repoCfg = {};
    try {
      const token = await this.repoToken(p, 'read');
      const text = await fetchRepoFile(p.repoUrl, baseBranch, 'bivouac.yml', token);
      if (text) repoCfg = parseProjectConfig(text);
    } catch (e: any) {
      throw new UserError(`Cannot read the repository (branch ${baseBranch}): ${e.message}. ${p.githubRepo ? 'Check that the GitHub App still has access to it.' : 'Check the project token.'}`, 'repo_unreachable', 502);
    }
    const eff = mergeConfig(repoCfg, p.config, this.defaultBudget());
    const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number(v));
    const maxIterations = num(o.maxIterations, eff.budget?.max_iterations ?? 10);
    const maxCostUsd = num(o.maxCostUsd, eff.budget?.max_cost_usd ?? 20);
    if (![maxIterations, maxCostUsd].every((n) => Number.isFinite(n) && n > 0)) throw new UserError('maxIterations and maxCostUsd must be positive numbers.', 'invalid');
    const task = this.store.createTask({
      projectId: p.id, name: o.name, title: prompt.split('\n')[0].slice(0, 80), prompt, successCommand: String(o.successCommand || eff.success || 'true'),
      baseBranch, maxIterations, maxCostUsd, maxTokens: o.maxTokens ? Number(o.maxTokens) : eff.budget?.max_tokens ?? null,
    }, (id) => `agent/t-${id}-${o.name}`);
    if (o.idempotencyKey) this.store.db.prepare('INSERT OR IGNORE INTO idempotency(key, project_id, task_id) VALUES (?,?,?)').run(o.idempotencyKey, p.id, task.id);
    this.auth.audit(actor.label, 'task_created', { project: p.name, task: o.name, id: task.id });
    this.mgr.enqueue(task.id);
    return { task: this.store.getTask(task.id)!, created: true };
  }
  /** Budgets set in the dashboard apply to new tasks of every project (below the project's own bivouac.yml). */
  defaultBudget() {
    const it = Number(this.store.getSetting('default_max_iterations') ?? 0), cost = Number(this.store.getSetting('default_max_cost_usd') ?? 0);
    return { budget: { ...(it > 0 ? { max_iterations: it } : {}), ...(cost > 0 ? { max_cost_usd: cost } : {}) } };
  }
  async stopTask(t: Task, actor: Actor) {
    await this.mgr.stop(t.id);
    this.auth.audit(actor.label, 'task_stopped', { task: t.name, project: t.projectName });
    return this.store.getTask(t.id)!;
  }
  async resumeTask(t: Task, actor: Actor, text?: string) {
    this.assertClaude();
    await this.mgr.resume(t.id, text);
    this.auth.audit(actor.label, 'task_resumed', { task: t.name, project: t.projectName });
    return this.store.getTask(t.id)!;
  }
  async instruct(t: Task, text: string, actor: Actor) {
    if (!text.trim()) throw new UserError('text is required', 'invalid');
    if (!this.mgr.isActive(t.id)) this.assertClaude();
    this.auth.audit(actor.label, 'task_instruction', { task: t.name });
    return this.mgr.instruct(t.id, text.trim());
  }
  renameTask(t: Task, name: string, actor: Actor) {
    const err = validateTaskName(name);
    if (err) throw new UserError(err, 'invalid_name');
    if (this.store.taskNameTaken(t.projectId, name, t.id)) throw new UserError(`The name "${name}" is already used in this project. Choose another name.`, 'name_taken', 409);
    const shares = this.previews.listShares(t.id).filter((s) => s.active).length;
    this.store.renameTask(t.id, name);
    for (const s of this.previews.listShares(t.id)) if (s.active) this.previews.revokeShare(s.id);
    this.auth.audit(actor.label, 'task_renamed', { from: t.name, to: name, revokedShares: shares });
    return this.store.getTask(t.id)!;
  }
  async deleteTask(t: Task, force: boolean, actor: Actor) {
    await this.mgr.destroy(t.id, force);
    this.auth.audit(actor.label, 'task_deleted', { task: t.name, project: t.projectName });
  }
  async pushBranch(t: Task, actor: Actor) {
    try { await this.mgr.push(t.id); } catch (e: any) { throw new UserError(`Push failed: ${e.message}. ${t.pushed ? '' : 'The GitHub App needs write access to contents on this repository.'}`, 'push_failed', 502); }
    this.auth.audit(actor.label, 'branch_pushed', { task: t.name, branch: t.branch });
    return this.store.getTask(t.id)!;
  }
  async openPr(t: Task, actor: Actor) {
    try {
      const url = await this.mgr.openPr(t.id);
      this.auth.audit(actor.label, 'pr_opened', { task: t.name, url });
      return url;
    } catch (e: any) {
      if (/not connected to GitHub/i.test(e.message)) throw new UserError(e.message, 'no_github', 412);
      throw new UserError(`Could not open the pull request: ${e.message}`, 'pr_failed', 502);
    }
  }
  createShareLink(t: Task, duration: ShareDuration, actor: Actor) {
    if (!t.previewUrl) throw new UserError('This task has no preview yet.', 'no_preview');
    const s = this.previews.createShare(t.id, duration);
    this.auth.audit(actor.label, 'share_created', { task: t.name, duration });
    return { id: s.id, url: this.shareUrl(t, s.token), expiresAt: s.expiresAt };
  }
  shareUrl(t: Task, token: string) { return `${t.previewUrl}/?bv_share=${token}`; }
  revokeShareLink(t: Task, id: number, actor: Actor) {
    const s = this.previews.getShare(id);
    if (!s || s.taskId !== t.id) throw new UserError(`No share link ${id} on this task. Use get_task to see its share links.`, 'unknown_share', 404);
    this.previews.revokeShare(id);
    this.auth.audit(actor.label, 'share_revoked', { task: t.name, id });
  }
  ownerPreviewUrl(t: Task) {
    return `${t.previewUrl}/?bv_ticket=${this.previews.createTicket(t.id)}`;
  }

  /** What an assistant needs to report on a task: the status plus the last things the agent said. */
  describeTask(t: Task) {
    const events = this.store.listEvents(t.id, 0, 5000);
    const messages = events.filter((e) => e.kind === 'assistant_text').slice(-3).map((e) => String(e.data.text ?? '').slice(0, 600));
    const checks = events.filter((e) => e.kind === 'check');
    const lastCheck = checks[checks.length - 1];
    return {
      ...this.summary(t),
      pendingInstructions: this.store.pendingInstructionCount(t.id),
      lastMessages: messages,
      lastCheck: lastCheck ? { command: lastCheck.data.command, exitCode: lastCheck.data.exitCode, output: String(lastCheck.data.output ?? '').slice(-1200) } : null,
      shareLinks: this.previews.listShares(t.id).filter((s) => s.active).map((s) => ({ id: s.id, url: this.shareUrl(t, this.previews.shareToken(s.id) ?? ''), expiresAt: s.expiresAt ? new Date(s.expiresAt * 1000).toISOString() : null })),
    };
  }
}
