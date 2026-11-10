import { mergeConfig, parseProjectConfig, slugify, titleFromPrompt, validateTaskName, type Project, type Task } from '@bivouac/shared';
import type { DaemonConfig } from './config.js';
import { baseUrl } from './config.js';
import type { Auth } from './auth.js';
import type { Store } from './db.js';
import { detectDefaultBranch, fetchRepoFile } from './git.js';
import type { GithubApp } from './githubapp.js';
import type { Previews, ShareDuration } from './preview.js';
import type { TaskManager } from './runner.js';
import { TOKEN_LIFETIME_DAYS } from './claude.js';
import { resolveClaude } from './accounts.js';
import type { Updates } from './updates.js';
import type { ProjectContext } from './projectcontext.js';

/** An error whose message is safe and useful to show to a person or to a model (it says what to do next). */
export class UserError extends Error {
  constructor(message: string, public code = 'invalid', public status: 400 | 404 | 409 | 412 | 502 = 400) { super(message); }
}

/**
 * The message for a failed push. Permissions are only blamed on a real authorization error (HTTP 403 or "permission denied"):
 * a failure for another reason (network, rejected update, hook…) must not send the owner to the wrong place.
 */
export function pushFailureMessage(raw: string): string {
  const msg = raw.trim();
  if (/\b403\b|permission to .* denied|write access to repository not granted|permission denied/i.test(msg)) {
    return `Push failed: GitHub refused the write (${msg}). The GitHub App (or the project token) needs write access to “Contents” on this repository.`;
  }
  if (/non-fast-forward|fetch first|\[rejected\]|stale info/i.test(msg)) return `Push failed: the remote branch has commits this one does not (${msg}). Ask the agent to rebase on it or resolve it by hand.`;
  if (/could not resolve host|unable to access|timed out|connection (reset|refused)/i.test(msg)) return `Push failed: GitHub could not be reached (${msg}). Try again in a moment.`;
  return `Push failed: ${msg}`;
}

/** Limits an owner (or an assistant) can change on an existing task. */
export interface TaskLimits { maxCostUsd?: number | null; maxIterations?: number | null; maxTokens?: number | null; successCommand?: string | null }

export interface Actor { kind: 'user' | 'mcp' | 'system'; label: string }

export interface TaskSummary {
  id: number; name: string; project: string; title: string; status: string; iteration: number; maxIterations: number;
  costUsd: number; /** 'estimated_api_equivalent' with a subscription (not a spend), 'cost' with an API key. */ costKind: 'estimated_api_equivalent' | 'cost'; maxCostUsd: number; maxTokens: number | null; successCommand: string; tokens: number; previewUrl: string | null; dashboardUrl: string; prUrl: string | null; pushed: boolean;
  branch: string; error: string | null; createdAt: string; finishedAt: string | null;
  /** Every exposed port with its URL (the main one first). */
  urls: { name: string; port: number; main: boolean; url: string }[];
  services: { name: string; image: string }[];
  configError: string | null;
}

/** Everything the dashboard and the MCP server can do. One place for validation, messages and the audit trail. */
export class Service {
  /** Set after construction (the updater needs the task manager). */
  updates: Updates | null = null;
  pctx!: ProjectContext;
  constructor(public store: Store, public cfg: DaemonConfig, public mgr: TaskManager, public auth: Auth, public gh: GithubApp, public previews: Previews, private fetchImpl: typeof fetch = fetch) {}

  // ---- links
  base() { return baseUrl(this.cfg); }
  dashboardUrl(path = '') { return this.base() + path; }
  taskUrl(t: Pick<Task, 'projectName' | 'name'>) { return this.dashboardUrl(`/projects/${t.projectName}/${t.name}`); }

  /**
   * With a subscription the CLI's cost is the API-equivalent estimate, not money spent; only an API key is billed per token.
   * The dollar budget still bounds consumption in both cases.
   */
  costKind(projectId?: number): 'estimated_api_equivalent' | 'cost' {
    return resolveClaude(this.store, this.cfg, projectId)?.kind === 'apikey' ? 'cost' : 'estimated_api_equivalent';
  }

  // ---- Claude accounts
  /** Status of the account a project would use (the default account without a project). */
  claudeStatus(projectId?: number): { connected: boolean; kind: 'oauth' | 'apikey' | null; expiresAt: string | null; expired: boolean; accountName: string | null; accountId: number | null; accounts: number } {
    const c = resolveClaude(this.store, this.cfg, projectId);
    return { connected: !!c, kind: c?.kind === 'apikey' ? 'apikey' : c ? 'oauth' : null, expiresAt: c?.expiresAt ?? null, expired: !!c?.expired, accountName: c?.name ?? null, accountId: c?.id ?? null, accounts: this.store.listClaudeAccounts().length };
  }
  listClaudeAccounts() {
    const accounts = this.store.listClaudeAccounts(TOKEN_LIFETIME_DAYS);
    if (accounts.length === 0 && (this.cfg.oauthToken || this.cfg.apiKey)) {
      // credentials given through the server environment: shown as read-only "Default"
      return [{ id: 0, name: 'Default', kind: this.cfg.apiKey ? 'apikey' as const : 'oauth' as const, connectedAt: '', expiresAt: null, expired: false, isDefault: true, projects: 0 }];
    }
    return accounts;
  }
  private accountName(raw: unknown, exceptId?: number): string {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 40) throw new UserError('Give the account a short name (1 to 40 characters), for example “Personal”.', 'invalid');
    if (this.store.claudeAccountNameTaken(name, exceptId)) throw new UserError(`An account named “${name}” already exists. Pick another name.`, 'name_taken', 409);
    return name;
  }
  checkAccountName(raw: unknown) { return this.accountName(raw); }
  /** Stores the token of a finished sign-in: a new account, or the renewal of an existing one. */
  saveClaudeLogin(o: { token: string; name?: string; accountId?: number }, actor: string): number {
    if (o.accountId) {
      if (!this.store.getClaudeAccount(o.accountId)) throw new UserError('This Claude account does not exist anymore.', 'unknown_account', 404);
      this.store.renewClaudeAccount(o.accountId, { kind: 'oauth', secret: o.token });
      this.auth.audit(actor, 'claude_renewed', { account: o.accountId });
      return o.accountId;
    }
    const id = this.store.createClaudeAccount({ name: this.accountName(o.name ?? (this.store.listClaudeAccounts().length ? '' : 'Default')), kind: 'oauth', secret: o.token });
    this.auth.audit(actor, 'claude_connected', { kind: 'oauth', account: id });
    return id;
  }
  saveClaudeApiKey(o: { key: string; name?: string; accountId?: number }, actor: string): number {
    const key = String(o.key ?? '').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new UserError('This does not look like an Anthropic API key (it starts with sk-ant-).');
    if (o.accountId) {
      if (!this.store.getClaudeAccount(o.accountId)) throw new UserError('This Claude account does not exist anymore.', 'unknown_account', 404);
      this.store.renewClaudeAccount(o.accountId, { kind: 'apikey', secret: key });
      this.auth.audit(actor, 'claude_renewed', { account: o.accountId });
      return o.accountId;
    }
    const id = this.store.createClaudeAccount({ name: this.accountName(o.name ?? (this.store.listClaudeAccounts().length ? '' : 'Default')), kind: 'apikey', secret: key });
    this.auth.audit(actor, 'claude_connected', { kind: 'apikey', account: id });
    return id;
  }
  updateClaudeAccount(id: number, o: { name?: string; isDefault?: boolean }, actor: string) {
    if (!this.store.getClaudeAccount(id)) throw new UserError('This Claude account does not exist.', 'unknown_account', 404);
    if (o.name !== undefined) this.store.renameClaudeAccount(id, this.accountName(o.name, id));
    if (o.isDefault) this.store.setDefaultClaudeAccount(id);
    this.auth.audit(actor, 'claude_account_updated', { account: id });
  }
  deleteClaudeAccount(id: number, actor: string) {
    const a = this.store.getClaudeAccount(id);
    if (!a) throw new UserError('This Claude account does not exist.', 'unknown_account', 404);
    const others = this.store.listClaudeAccounts().filter((x) => x.id !== id);
    if (a.isDefault && others.length) throw new UserError('This is the default account. Make another account the default first, then delete this one.', 'is_default', 409);
    this.store.deleteClaudeAccount(id);
    this.auth.audit(actor, 'claude_disconnected', { account: id });
  }
  /** Name of the account a project uses, for display (never the token). */
  accountNameFor(projectId: number): string | null { return resolveClaude(this.store, this.cfg, projectId)?.name ?? null; }
  /** No task may start while an update is scheduled or running: the error tells the assistant why and when to retry. */
  private assertAccepting() {
    const why = this.updates?.blockReason();
    if (why) throw new UserError(why, 'updating', 409);
  }
  private assertClaude(projectId?: number) {
    const c = resolveClaude(this.store, this.cfg, projectId);
    const link = this.dashboardUrl('/settings/claude');
    if (!c) throw new UserError(`Claude is not connected. Ask the user to connect a Claude account in the bivouac dashboard, then retry. Link: ${link}`, 'claude_not_connected', 412);
    if (c.expired) throw new UserError(`The token of the Claude account “${c.name}” has expired. Ask the user to reconnect it in the dashboard, then retry. Link: ${link}`, 'claude_expired', 412);
  }

  // ---- projects
  listProjects() {
    return this.store.listProjects().map((p) => ({ ...p, totals: this.store.totals(p.id), claudeAccountName: this.accountNameFor(p.id), stats: this.store.projectStats(p.id) }));
  }
  private prCache = new Map<number, { at: number; prs: { number: number; url: string; title: string; branch: string }[] | null }>();
  /** Open pull requests opened by agents (branches `agent/…`) on a project's repository; null when GitHub cannot be asked. Cached for a minute. */
  async openPullRequests(p: Project): Promise<{ number: number; url: string; title: string; branch: string }[] | null> {
    const hit = this.prCache.get(p.id);
    if (hit && Date.now() - hit.at < 60_000) return hit.prs;
    let prs: { number: number; url: string; title: string; branch: string }[] | null = null;
    const gh = p.githubRepo ?? /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(p.repoUrl)?.[1];
    try {
      const token = await this.repoToken(p, 'read');
      if (gh && token) {
        const r = await this.fetchImpl(`https://api.github.com/repos/${gh}/pulls?state=open&per_page=100`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'bivouac' } });
        if (r.ok) prs = ((await r.json()) as any[]).filter((x) => String(x.head?.ref).startsWith('agent/')).map((x) => ({ number: x.number, url: x.html_url, title: x.title, branch: x.head.ref }));
      }
    } catch { /* no token, GitHub unreachable: unknown */ }
    this.prCache.set(p.id, { at: Date.now(), prs });
    return prs;
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
    const gh = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
    if (gh && o.token) {
      // a GitHub repository with a token: check the token's access and permissions with a clear message before saving
      try { const info = await this.gh.checkRepoToken(gh[1], o.token); branch = o.defaultBranch || info.defaultBranch; }
      catch (e: any) { throw new UserError(e.message, 'invalid_token', 400); }
    } else {
      try { branch = o.defaultBranch || (await detectDefaultBranch(repoUrl, o.token)); } catch (e: any) { throw new UserError(`Cannot access the repository: ${e.message}`, 'repo_unreachable'); }
    }
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
      costUsd: t.usage.costUsd, costKind: this.costKind(t.projectId), maxCostUsd: t.maxCostUsd, maxTokens: t.maxTokens, successCommand: t.successCommand, tokens: t.usage.inputTokens + t.usage.outputTokens + t.usage.cacheCreationTokens,
      previewUrl: t.previewUrl, dashboardUrl: this.taskUrl(t), prUrl: t.prUrl, pushed: t.pushed, branch: t.branch, error: t.error, createdAt: t.createdAt, finishedAt: t.finishedAt,
      urls: t.ports.map((p) => ({ name: p.name, port: p.port, main: p.primary, url: p.url })), services: t.services, configError: t.configError,
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

  /** A free task name derived from the prompt, for the dashboard form where the name is optional. */
  suggestTaskName(project: string | number, prompt: string): string {
    const p = this.resolveProject(project);
    const base = slugify(titleFromPrompt(prompt, 60), 34) || 'task';
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      if (!this.store.taskNameTaken(p.id, name)) return name;
    }
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
    this.assertAccepting();
    this.assertClaude(p.id);
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
      projectId: p.id, name: o.name, title: titleFromPrompt(prompt), prompt, successCommand: String(o.successCommand || eff.success || 'true'),
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
  /** Validates the limits given by a person or an assistant; undefined/null/'' means “leave as is”. */
  private parseLimits(o: TaskLimits): { maxCostUsd?: number; maxIterations?: number; maxTokens?: number; successCommand?: string } {
    const out: { maxCostUsd?: number; maxIterations?: number; maxTokens?: number; successCommand?: string } = {};
    const given = (v: unknown) => v !== undefined && v !== null && v !== '';
    if (given(o.maxCostUsd)) {
      const n = Number(o.maxCostUsd);
      if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new UserError('The cost limit must be a positive number of dollars, for example 30.', 'invalid');
      out.maxCostUsd = Math.round(n * 100) / 100;
    }
    if (given(o.maxIterations)) {
      const n = Number(o.maxIterations);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UserError('The attempt limit must be a whole number between 1 and 1000.', 'invalid');
      out.maxIterations = n;
    }
    if (given(o.maxTokens)) {
      const n = Number(o.maxTokens);
      if (!Number.isInteger(n) || n < 1) throw new UserError('The token limit must be a positive whole number.', 'invalid');
      out.maxTokens = n;
    }
    if (given(o.successCommand)) {
      const c = String(o.successCommand).trim();
      if (!c) throw new UserError('The success command cannot be empty. It must exit with 0 when the work is done, for example "pnpm test && pnpm build".', 'invalid');
      if (c.length > 4000) throw new UserError('The success command is too long (4000 characters at most). Put the logic in a script of the repository.', 'invalid');
      out.successCommand = c;
    }
    return out;
  }
  /** Why a task cannot continue with these limits, or null. */
  private exhausted(t: Task, l: { maxCostUsd?: number; maxTokens?: number }): string | null {
    const cost = t.usage.costUsd, maxCost = l.maxCostUsd ?? t.maxCostUsd, kind = this.costKind(t.projectId) === 'cost' ? 'cost' : 'estimated API equivalent';
    if (maxCost - cost <= 0.0001) {
      return `This task has used its whole budget: $${cost.toFixed(2)} ${kind} of the $${maxCost.toFixed(2)} limit. Raise the limit to continue it, for example to $${(Math.ceil((cost * 1.5) / 5) * 5 || 5).toFixed(0)}: pass max_cost_usd to resume_task (or use update_task), or change “Budget” on the task page.`;
    }
    const tok = t.usage.inputTokens + t.usage.outputTokens + t.usage.cacheCreationTokens, maxTok = l.maxTokens ?? t.maxTokens;
    if (maxTok && tok >= maxTok) return `This task has used its whole token limit (${tok} of ${maxTok}). Raise max_tokens to continue it (resume_task or update_task).`;
    return null;
  }
  /** Changes the limits of an existing task. They apply from the next attempt (an attempt already running keeps its cap). */
  updateTaskLimits(t: Task, o: TaskLimits, actor: Actor): Task {
    const l = this.parseLimits(o);
    if (!Object.keys(l).length) throw new UserError('Nothing to change: give at least one of max_cost_usd, max_iterations, max_tokens or success_command.', 'invalid');
    return this.applyLimits(t, l, actor);
  }
  private applyLimits(t: Task, l: ReturnType<Service['parseLimits']>, actor: Actor): Task {
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    const cur: Record<string, unknown> = { maxCostUsd: t.maxCostUsd, maxIterations: t.maxIterations, maxTokens: t.maxTokens, successCommand: t.successCommand };
    for (const [k, v] of Object.entries(l)) if (cur[k] !== v) changes.push({ field: k, from: cur[k], to: v });
    if (!changes.length) return t;
    this.store.patchTask(t.id, l);
    const label = { maxCostUsd: 'Budget', maxIterations: 'Attempt limit', maxTokens: 'Token limit', successCommand: 'Success command' } as Record<string, string>;
    const show = (f: string, v: unknown) => (f === 'maxCostUsd' ? `$${Number(v).toFixed(2)}` : v === null ? 'none' : String(v));
    this.store.addEvent(t.id, 'system', { subtype: 'limits_changed', by: actor.label, changes, message: `${changes.map((c) => `${label[c.field]}: ${show(c.field, c.from)} → ${show(c.field, c.to)}`).join('; ')}. Applies from the next attempt.` });
    this.auth.audit(actor.label, 'task_limits_updated', { task: t.name, project: t.projectName, changes: changes.map((c) => c.field) });
    return this.store.getTask(t.id)!;
  }
  async resumeTask(t: Task, actor: Actor, text?: string, limits: TaskLimits = {}) {
    this.assertAccepting();
    this.assertClaude(t.projectId);
    const l = this.parseLimits(limits);
    // a task that stopped on its budget cannot do anything with a plain resume: say so, with the way out
    const why = this.exhausted(t, l);
    if (why && (t.status === 'budget_exceeded' || l.maxCostUsd !== undefined || l.maxTokens !== undefined)) throw new UserError(why, 'budget_exhausted', 409);
    if (Object.keys(l).length) t = this.applyLimits(t, l, actor);
    await this.mgr.resume(t.id, text);
    this.auth.audit(actor.label, 'task_resumed', { task: t.name, project: t.projectName });
    return this.store.getTask(t.id)!;
  }
  async instruct(t: Task, text: string, actor: Actor) {
    if (!text.trim()) throw new UserError('text is required', 'invalid');
    if (!this.mgr.isActive(t.id)) { this.assertAccepting(); this.assertClaude(t.projectId); }
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
    try { await this.mgr.push(t.id); } catch (e: any) { throw new UserError(pushFailureMessage(String(e?.message ?? e)), 'push_failed', 502); }
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
    return { id: s.id, url: this.shareUrl(t, s.token), urls: this.shareUrls(t, s.token), expiresAt: s.expiresAt };
  }
  shareUrl(t: Task, token: string) { return `${t.previewUrl}/?bv_share=${token}`; }
  /** One link per exposed port: a share link opens every port of the task. */
  shareUrls(t: Task, token: string) { return t.ports.map((p) => ({ name: p.name, url: `${p.url}/?bv_share=${token}` })); }
  revokeShareLink(t: Task, id: number, actor: Actor) {
    const s = this.previews.getShare(id);
    if (!s || s.taskId !== t.id) throw new UserError(`No share link ${id} on this task. Use get_task to see its share links.`, 'unknown_share', 404);
    this.previews.revokeShare(id);
    this.auth.audit(actor.label, 'share_revoked', { task: t.name, id });
  }
  ownerPreviewUrl(t: Task, portName?: string) {
    const port = portName ? t.ports.find((p) => p.name === portName) : t.ports.find((p) => p.primary);
    if (portName && !port) throw new UserError(`This task has no port "${portName}". Available: ${t.ports.map((p) => p.name).join(', ')}.`, 'unknown_port', 404);
    return `${port?.url ?? t.previewUrl}/?bv_ticket=${this.previews.createTicket(t.id)}`;
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
      shareLinks: this.previews.listShares(t.id).filter((s) => s.active).map((s) => ({ id: s.id, url: this.shareUrl(t, this.previews.shareToken(s.id) ?? ''), urls: this.shareUrls(t, this.previews.shareToken(s.id) ?? ''), expiresAt: s.expiresAt ? new Date(s.expiresAt * 1000).toISOString() : null })),
    };
  }
}
