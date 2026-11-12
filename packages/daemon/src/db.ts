import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { emptyUsage, TERMINAL_STATUSES, type PortDef, type ServiceConfig, type EventKind, type ClaudeAccount, type PreviewHealth, type Project, type ProjectConfig, type Task, type TaskEvent, type TaskStatus, type Usage } from '@bivouac/shared';
import { decrypt, encrypt } from './crypto.js';
import type { RouteTask } from './routes.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL, github_token_enc TEXT, config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, prompt TEXT NOT NULL, success_command TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL,
  status TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, max_iterations INTEGER NOT NULL, max_cost_usd REAL NOT NULL, max_tokens INTEGER,
  session_id TEXT, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  public_preview INTEGER NOT NULL DEFAULT 0, preview_user TEXT, preview_pass_enc TEXT,
  pushed INTEGER NOT NULL DEFAULT 0, pr_url TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), started_at TEXT, finished_at TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, iteration INTEGER NOT NULL,
  kind TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
CREATE INDEX IF NOT EXISTS events_attempt ON events(task_id, iteration, id);
CREATE TABLE IF NOT EXISTS users (
  github_id INTEGER PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_login_at TEXT);
CREATE TABLE IF NOT EXISTS allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT, UNIQUE(kind, value));
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, github_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'web',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, github_id INTEGER NOT NULL, redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, github_id INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE, type TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, token_enc TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS preview_tickets (
  hash TEXT PRIMARY KEY, task_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY, project_id INTEGER NOT NULL, task_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claude_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, kind TEXT NOT NULL, secret_enc TEXT NOT NULL,
  connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, attempt INTEGER NOT NULL,
  page TEXT NOT NULL, width INTEGER NOT NULL, http_status INTEGER, title TEXT, ok INTEGER NOT NULL, blank INTEGER NOT NULL DEFAULT 0,
  problems_json TEXT NOT NULL DEFAULT '[]', console_json TEXT NOT NULL DEFAULT '[]', failed_json TEXT NOT NULL DEFAULT '[]',
  bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS shots_task ON shots(task_id, attempt);
CREATE TABLE IF NOT EXISTS shot_runs (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, attempt INTEGER NOT NULL, check_passed INTEGER, error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (task_id, attempt));
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, text TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS attempt_git (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, attempt INTEGER NOT NULL,
  start_head TEXT, start_snap TEXT, end_head TEXT, end_snap TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ended_at TEXT, PRIMARY KEY (task_id, attempt));
CREATE TABLE IF NOT EXISTS instructions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, text TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
`;

/** What a task exposes right now, from the last valid bivouac.yml. */
export interface LiveConfig { ports: PortDef[]; services: Record<string, ServiceConfig>; error: string | null; repo?: ProjectConfig }

export type StoreMessage = { type: 'task'; task: Task } | { type: 'event'; event: TaskEvent } | { type: 'project'; projectId: number };

export class Store {
  readonly db: Database.Database;
  readonly bus = new EventEmitter();
  /** Resolves the preview URL for a task row (injected so the store stays config-free). */
  previewUrlFor: (project: string, taskName: string, portName?: string) => string = () => '';
  /** URL of a project alias (`<alias>.<domain>`, or `<port>.<alias>.<domain>`). */
  aliasUrlFor: (alias: string, portName?: string) => string = () => '';

  constructor(path: string, private key: Buffer) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
    this.bus.setMaxListeners(200);
  }

  /** Upgrades a database created by bivouac 0.1.x. */
  private migrate() {
    const cols = (t: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    if (!cols('tasks').includes('name')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN name TEXT; UPDATE tasks SET name = 't-' || id WHERE name IS NULL;`);
    }
    if (!cols('tasks').includes('dev_port')) this.db.exec('ALTER TABLE tasks ADD COLUMN dev_port INTEGER');
    if (!cols('tasks').includes('live_config')) this.db.exec('ALTER TABLE tasks ADD COLUMN live_config TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_name ON tasks(project_id, name)');
    const pc = cols('projects');
    if (!pc.includes('github_repo')) this.db.exec('ALTER TABLE projects ADD COLUMN github_repo TEXT');
    if (!pc.includes('installation_id')) this.db.exec('ALTER TABLE projects ADD COLUMN installation_id INTEGER');
    if (!pc.includes('claude_account_id')) this.db.exec('ALTER TABLE projects ADD COLUMN claude_account_id INTEGER');
    if (!cols('tasks').includes('account_name')) this.db.exec('ALTER TABLE tasks ADD COLUMN account_name TEXT');
    if (!cols('tasks').includes('preview_json')) this.db.exec('ALTER TABLE tasks ADD COLUMN preview_json TEXT');
    if (!pc.includes('alias')) this.db.exec('ALTER TABLE projects ADD COLUMN alias TEXT');
    if (!pc.includes('alias_task_id')) this.db.exec('ALTER TABLE projects ADD COLUMN alias_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL');
    if (!pc.includes('alias_public_paths')) this.db.exec("ALTER TABLE projects ADD COLUMN alias_public_paths TEXT NOT NULL DEFAULT '[]'");
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS projects_alias ON projects(alias) WHERE alias IS NOT NULL');
    this.migrateClaudeAccounts();
  }

  /**
   * v0.4: the single Claude token / API key of earlier versions becomes the account "Default" (the API key wins when both
   * existed, as it did for the CLI). Idempotent: the old settings are removed once copied.
   */
  private migrateClaudeAccounts() {
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM claude_accounts').get() as any).n > 0) return;
    const oauth = this.getSecretSetting('claude_oauth_token'), key = this.getSecretSetting('anthropic_api_key');
    const at = this.getSetting('claude_token_at') ?? new Date().toISOString();
    if (!oauth && !key) return;
    const tx = this.db.transaction(() => {
      if (key) this.db.prepare('INSERT INTO claude_accounts(name,kind,secret_enc,connected_at,is_default) VALUES(?,?,?,?,1)').run('Default', 'apikey', encrypt(this.key, key), at);
      if (oauth) this.db.prepare('INSERT INTO claude_accounts(name,kind,secret_enc,connected_at,is_default) VALUES(?,?,?,?,?)').run(key ? 'Default (subscription)' : 'Default', 'oauth', encrypt(this.key, oauth), at, key ? 0 : 1);
      for (const k of ['claude_oauth_token', 'anthropic_api_key', 'claude_token_at']) this.db.prepare('DELETE FROM settings WHERE key=?').run(k);
    });
    tx();
  }

  // ---- Claude accounts
  private accountFromRow(r: any, lifetimeDays: number): ClaudeAccount {
    const expiresAt = r.kind === 'oauth' ? new Date(Date.parse(r.connected_at) + lifetimeDays * 86400_000).toISOString() : null;
    const used = (this.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE claude_account_id=?').get(r.id) as any).n as number;
    return { id: r.id, name: r.name, kind: r.kind, connectedAt: r.connected_at, expiresAt, expired: !!expiresAt && Date.parse(expiresAt) < Date.now(), isDefault: !!r.is_default, projects: used };
  }
  listClaudeAccounts(lifetimeDays = 365): ClaudeAccount[] {
    return this.db.prepare('SELECT * FROM claude_accounts ORDER BY is_default DESC, id').all().map((r) => this.accountFromRow(r, lifetimeDays));
  }
  getClaudeAccount(id: number, lifetimeDays = 365): ClaudeAccount | null {
    const r = this.db.prepare('SELECT * FROM claude_accounts WHERE id=?').get(id);
    return r ? this.accountFromRow(r, lifetimeDays) : null;
  }
  getDefaultClaudeAccount(lifetimeDays = 365): ClaudeAccount | null {
    const r = this.db.prepare('SELECT * FROM claude_accounts ORDER BY is_default DESC, id LIMIT 1').get();
    return r ? this.accountFromRow(r, lifetimeDays) : null;
  }
  getClaudeSecret(id: number): string | null {
    const r = this.db.prepare('SELECT secret_enc FROM claude_accounts WHERE id=?').get(id) as any;
    return r ? decrypt(this.key, r.secret_enc) : null;
  }
  /** Names are unique, case-insensitively. The first account becomes the default. */
  createClaudeAccount(a: { name: string; kind: 'oauth' | 'apikey'; secret: string }): number {
    const first = (this.db.prepare('SELECT COUNT(*) AS n FROM claude_accounts').get() as any).n === 0;
    const info = this.db.prepare('INSERT INTO claude_accounts(name,kind,secret_enc,is_default) VALUES(?,?,?,?)').run(a.name, a.kind, encrypt(this.key, a.secret), first ? 1 : 0);
    return Number(info.lastInsertRowid);
  }
  claudeAccountNameTaken(name: string, exceptId?: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM claude_accounts WHERE name=? COLLATE NOCASE AND id<>?').get(name, exceptId ?? -1);
  }
  renameClaudeAccount(id: number, name: string) { this.db.prepare('UPDATE claude_accounts SET name=? WHERE id=?').run(name, id); }
  renewClaudeAccount(id: number, a: { kind: 'oauth' | 'apikey'; secret: string }) {
    this.db.prepare("UPDATE claude_accounts SET kind=?, secret_enc=?, connected_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.kind, encrypt(this.key, a.secret), id);
  }
  setDefaultClaudeAccount(id: number) {
    this.db.transaction(() => { this.db.prepare('UPDATE claude_accounts SET is_default=0').run(); this.db.prepare('UPDATE claude_accounts SET is_default=1 WHERE id=?').run(id); })();
  }
  /** Projects that used it fall back to the default account. */
  deleteClaudeAccount(id: number) {
    this.db.transaction(() => { this.db.prepare('UPDATE projects SET claude_account_id=NULL WHERE claude_account_id=?').run(id); this.db.prepare('DELETE FROM claude_accounts WHERE id=?').run(id); })();
  }

  // ---- settings
  getSetting(k: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(k) as any;
    return r ? r.value : null;
  }
  setSetting(k: string, v: string | null) {
    if (v === null) this.db.prepare('DELETE FROM settings WHERE key=?').run(k);
    else this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
  }
  getSecretSetting(k: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(k) as any;
    return r ? decrypt(this.key, r.value) : null;
  }
  setSecretSetting(k: string, v: string | null) {
    if (v === null) this.db.prepare('DELETE FROM settings WHERE key=?').run(k);
    else this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, encrypt(this.key, v));
  }

  // ---- projects
  private projectFromRow(r: any): Project {
    return { id: r.id, name: r.name, repoUrl: r.repo_url, githubRepo: r.github_repo ?? null, installationId: r.installation_id ?? null, defaultBranch: r.default_branch, hasGithubToken: !!r.github_token_enc, claudeAccountId: r.claude_account_id ?? null, alias: r.alias ?? null, aliasTaskId: r.alias_task_id ?? null, aliasPublicPaths: JSON.parse(r.alias_public_paths ?? '[]'), config: JSON.parse(r.config_json), createdAt: r.created_at };
  }
  createProject(p: { name: string; repoUrl: string; defaultBranch: string; githubToken?: string | null; config?: ProjectConfig; githubRepo?: string | null; installationId?: number | null }): Project {
    const info = this.db.prepare('INSERT INTO projects(name,repo_url,default_branch,github_token_enc,config_json,github_repo,installation_id) VALUES(?,?,?,?,?,?,?)')
      .run(p.name, p.repoUrl, p.defaultBranch, p.githubToken ? encrypt(this.key, p.githubToken) : null, JSON.stringify(p.config ?? {}), p.githubRepo ?? null, p.installationId ?? null);
    this.bus.emit('msg', { type: 'project', projectId: Number(info.lastInsertRowid) } satisfies StoreMessage);
    return this.getProject(Number(info.lastInsertRowid))!;
  }
  getProject(id: number): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return r ? this.projectFromRow(r) : null;
  }
  getProjectByName(name: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE name=?').get(name);
    return r ? this.projectFromRow(r) : null;
  }
  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY id').all().map((r) => this.projectFromRow(r));
  }
  getProjectToken(id: number): string | null {
    const r = this.db.prepare('SELECT github_token_enc FROM projects WHERE id=?').get(id) as any;
    return r?.github_token_enc ? decrypt(this.key, r.github_token_enc) : null;
  }
  updateProject(id: number, patch: { config?: ProjectConfig; githubToken?: string | null; defaultBranch?: string; claudeAccountId?: number | null }) {
    if (patch.claudeAccountId !== undefined) this.db.prepare('UPDATE projects SET claude_account_id=? WHERE id=?').run(patch.claudeAccountId, id);
    if (patch.config !== undefined) this.db.prepare('UPDATE projects SET config_json=? WHERE id=?').run(JSON.stringify(patch.config), id);
    if (patch.githubToken !== undefined) this.db.prepare('UPDATE projects SET github_token_enc=? WHERE id=?').run(patch.githubToken ? encrypt(this.key, patch.githubToken) : null, id);
    if (patch.defaultBranch) this.db.prepare('UPDATE projects SET default_branch=? WHERE id=?').run(patch.defaultBranch, id);
    this.bus.emit('msg', { type: 'project', projectId: id } satisfies StoreMessage);
  }
  deleteProject(id: number) {
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    this.bus.emit('msg', { type: 'project', projectId: id } satisfies StoreMessage);
  }

  // ---- alias: a stable host (`<alias>.<domain>`) a project points at one of its tasks (OAuth callbacks, webhooks)
  aliasTaken(alias: string, exceptProjectId?: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM projects WHERE alias=? AND id<>?').get(alias, exceptProjectId ?? -1);
  }
  setProjectAlias(projectId: number, p: { alias?: string | null; taskId?: number | null; publicPaths?: string[] }) {
    if (p.alias !== undefined) this.db.prepare('UPDATE projects SET alias=?, alias_task_id=CASE WHEN ? IS NULL THEN NULL ELSE alias_task_id END WHERE id=?').run(p.alias, p.alias, projectId);
    if (p.taskId !== undefined) this.db.prepare('UPDATE projects SET alias_task_id=? WHERE id=?').run(p.taskId, projectId);
    if (p.publicPaths !== undefined) this.db.prepare('UPDATE projects SET alias_public_paths=? WHERE id=?').run(JSON.stringify(p.publicPaths), projectId);
    this.bus.emit('msg', { type: 'project', projectId } satisfies StoreMessage);
    for (const t of this.listTasks(projectId)) this.emitTask(t.id);
  }
  getProjectByAlias(alias: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE alias=?').get(alias);
    return r ? this.projectFromRow(r) : null;
  }

  // ---- tasks
  private taskFromRow(r: any): Task {
    const live: LiveConfig = r.live_config ? JSON.parse(r.live_config) : { ports: [], services: {}, error: null };
    const livePorts: PortDef[] = live.ports.length ? live.ports : r.dev_port ? [{ name: 'web', port: r.dev_port, primary: true }] : [];
    const aliased = r.project_alias && r.project_alias_task === r.id ? (r.project_alias as string) : null;
    const ports = livePorts.map((p) => ({ ...p, url: this.previewUrlFor(r.project_name, r.name, p.primary ? undefined : p.name), ...(aliased ? { aliasUrl: this.aliasUrlFor(aliased, p.primary ? undefined : p.name) } : {}) }));
    const usage: Usage = { inputTokens: r.in_tok, outputTokens: r.out_tok, cacheReadTokens: r.cache_read, cacheCreationTokens: r.cache_create, costUsd: r.cost_usd };
    return {
      id: r.id, projectId: r.project_id, projectName: r.project_name, name: r.name, title: r.title, prompt: r.prompt, successCommand: r.success_command,
      branch: r.branch, baseBranch: r.base_branch, status: r.status, iteration: r.iteration, maxIterations: r.max_iterations,
      maxCostUsd: r.max_cost_usd, maxTokens: r.max_tokens, sessionId: r.session_id, usage,
      devPort: r.dev_port ?? null, ports, services: Object.entries(live.services).map(([name, v]) => ({ name, image: v.image })), preview: r.preview_json ? JSON.parse(r.preview_json) : null, aliasUrl: aliased ? this.aliasUrlFor(aliased) : null, configError: live.error, previewUrl: this.previewUrlFor(r.project_name, r.name), pushed: !!r.pushed, prUrl: r.pr_url, error: r.error, accountName: r.account_name ?? null,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    };
  }
  private static TASK_SELECT = 'SELECT t.*, p.name AS project_name, p.alias AS project_alias, p.alias_task_id AS project_alias_task FROM tasks t JOIN projects p ON p.id=t.project_id';
  getLiveConfig(id: number): LiveConfig | null {
    const r = this.db.prepare('SELECT live_config FROM tasks WHERE id=?').get(id) as any;
    return r?.live_config ? JSON.parse(r.live_config) : null;
  }
  taskNameTaken(projectId: number, name: string, exceptId?: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM tasks WHERE project_id=? AND name=? AND id<>?').get(projectId, name, exceptId ?? -1);
  }
  getTaskByName(projectId: number, name: string): Task | null {
    const r = this.db.prepare(`${Store.TASK_SELECT} WHERE t.project_id=? AND t.name=?`).get(projectId, name);
    return r ? this.taskFromRow(r) : null;
  }
  /** Throws a SQLITE_CONSTRAINT error when `name` is already used in the project (callers pre-check for a friendly message). */
  createTask(t: { projectId: number; name: string; title: string; prompt: string; successCommand: string; baseBranch: string; maxIterations: number; maxCostUsd: number; maxTokens?: number | null }, slugFor: (id: number) => string): Task {
    const tx = this.db.transaction(() => {
      const info = this.db.prepare('INSERT INTO tasks(project_id,name,title,prompt,success_command,branch,base_branch,status,max_iterations,max_cost_usd,max_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(t.projectId, t.name, t.title, t.prompt, t.successCommand, 'pending', t.baseBranch, 'queued', t.maxIterations, t.maxCostUsd, t.maxTokens ?? null);
      const id = Number(info.lastInsertRowid);
      this.db.prepare('UPDATE tasks SET branch=? WHERE id=?').run(slugFor(id), id);
      return id;
    });
    const id = tx();
    const task = this.getTask(id)!;
    this.bus.emit('msg', { type: 'task', task } satisfies StoreMessage);
    return task;
  }
  getTask(id: number): Task | null {
    const r = this.db.prepare(`${Store.TASK_SELECT} WHERE t.id=?`).get(id);
    return r ? this.taskFromRow(r) : null;
  }
  renameTask(id: number, name: string) {
    this.db.prepare('UPDATE tasks SET name=? WHERE id=?').run(name, id);
    return this.emitTask(id)!;
  }
  listTasks(projectId?: number): Task[] {
    const rows = projectId ? this.db.prepare(`${Store.TASK_SELECT} WHERE t.project_id=? ORDER BY t.id DESC`).all(projectId) : this.db.prepare(`${Store.TASK_SELECT} ORDER BY t.id DESC`).all();
    return rows.map((r) => this.taskFromRow(r));
  }
  private emitTask(id: number) {
    const task = this.getTask(id);
    if (task) this.bus.emit('msg', { type: 'task', task } satisfies StoreMessage);
    return task;
  }
  setStatus(id: number, status: TaskStatus, error?: string | null) {
    const terminal = (TERMINAL_STATUSES as string[]).includes(status);
    this.db.prepare(`UPDATE tasks SET status=?, error=?, started_at=CASE WHEN ? AND started_at IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE started_at END, finished_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=?`)
      .run(status, error ?? null, status === 'starting' ? 1 : 0, terminal ? 1 : 0, id);
    this.addEvent(id, 'status', { status, error: error ?? null });
    return this.emitTask(id)!;
  }
  patchTask(id: number, p: Partial<{ devPort: number; liveConfig: LiveConfig; iteration: number; sessionId: string; pushed: boolean; prUrl: string; maxIterations: number; maxCostUsd: number; maxTokens: number | null; successCommand: string; error: string | null; accountName: string }>) {
    const m: Record<string, string> = { liveConfig: 'live_config', devPort: 'dev_port', iteration: 'iteration', sessionId: 'session_id', pushed: 'pushed', prUrl: 'pr_url', maxIterations: 'max_iterations', maxCostUsd: 'max_cost_usd', maxTokens: 'max_tokens', successCommand: 'success_command', error: 'error', accountName: 'account_name' };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      this.db.prepare(`UPDATE tasks SET ${m[k]}=? WHERE id=?`).run(typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' && v !== null ? JSON.stringify(v) : v, id);
    }
    return this.emitTask(id)!;
  }
  setUsage(id: number, u: Usage) {
    this.db.prepare('UPDATE tasks SET in_tok=?, out_tok=?, cache_read=?, cache_create=?, cost_usd=? WHERE id=?')
      .run(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheCreationTokens, u.costUsd, id);
    return this.emitTask(id)!;
  }
  setPreview(id: number, v: PreviewHealth | null) {
    this.db.prepare('UPDATE tasks SET preview_json=? WHERE id=?').run(v ? JSON.stringify(v) : null, id);
    return this.emitTask(id);
  }
  /** Notes for the agent (preview restarted…), shown in its next prompt. */
  addNotice(taskId: number, text: string) { this.db.prepare('INSERT INTO notices(task_id,text) VALUES(?,?)').run(taskId, text); }
  takeNotices(taskId: number): string[] {
    const rows = this.db.prepare('SELECT text FROM notices WHERE task_id=? AND consumed=0 ORDER BY id').all(taskId) as any[];
    if (rows.length) this.db.prepare('UPDATE notices SET consumed=1 WHERE task_id=? AND consumed=0').run(taskId);
    return rows.map((r) => r.text);
  }
  deleteTask(id: number) {
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    this.bus.emit('msg', { type: 'project', projectId: 0 } satisfies StoreMessage);
  }
  totals(projectId?: number): Usage & { tasks: number } {
    const r = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(in_tok),0) i, COALESCE(SUM(out_tok),0) o, COALESCE(SUM(cache_read),0) cr, COALESCE(SUM(cache_create),0) cc, COALESCE(SUM(cost_usd),0) c FROM tasks ${projectId ? 'WHERE project_id=?' : ''}`).get(...(projectId ? [projectId] : [])) as any;
    return { tasks: r.n, inputTokens: r.i, outputTokens: r.o, cacheReadTokens: r.cr, cacheCreationTokens: r.cc, costUsd: r.c };
  }

  /** Per project: tasks working or failing now, tasks with a pull request, and the last time anything happened. */
  projectStats(projectId: number): { running: number; failed: number; withPr: number; lastActivityAt: string | null } {
    const r = this.db.prepare(`SELECT
        SUM(status IN ('queued','starting','running','checking')) AS running,
        SUM(status IN ('failed','budget_exceeded','max_iterations','stuck','blocked')) AS failed,
        SUM(pr_url IS NOT NULL) AS with_pr,
        MAX(COALESCE(finished_at, started_at, created_at)) AS last FROM tasks WHERE project_id=?`).get(projectId) as any;
    return { running: r.running ?? 0, failed: r.failed ?? 0, withPr: r.with_pr ?? 0, lastActivityAt: r.last ?? null };
  }

  // ---- events & instructions
  addEvent(taskId: number, kind: EventKind, data: any, iteration?: number): TaskEvent {
    const it = iteration ?? (this.db.prepare('SELECT iteration FROM tasks WHERE id=?').get(taskId) as any)?.iteration ?? 0;
    const info = this.db.prepare('INSERT INTO events(task_id,iteration,kind,data_json) VALUES(?,?,?,?)').run(taskId, it, kind, JSON.stringify(data));
    const event = this.getEvent(Number(info.lastInsertRowid))!;
    this.bus.emit('msg', { type: 'event', event } satisfies StoreMessage);
    return event;
  }
  private eventFromRow(r: any): TaskEvent {
    return { id: r.id, taskId: r.task_id, iteration: r.iteration, kind: r.kind, data: JSON.parse(r.data_json), createdAt: r.created_at };
  }
  getEvent(id: number): TaskEvent | null {
    const r = this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
    return r ? this.eventFromRow(r) : null;
  }
  listEvents(taskId: number, afterId = 0, limit = 5000): TaskEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT ?').all(taskId, afterId, limit).map((r) => this.eventFromRow(r));
  }
  /** The most recent events of one kind, oldest first among them. */
  lastEvents(taskId: number, kind: EventKind, n: number): TaskEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT ?').all(taskId, kind, n).reverse().map((r) => this.eventFromRow(r));
  }
  addInstruction(taskId: number, text: string) {
    this.db.prepare('INSERT INTO instructions(task_id,text) VALUES(?,?)').run(taskId, text);
    this.addEvent(taskId, 'user_instruction', { text, queued: true });
  }
  takeInstructions(taskId: number): string[] {
    const rows = this.db.prepare('SELECT id,text FROM instructions WHERE task_id=? AND consumed=0 ORDER BY id').all(taskId) as any[];
    if (rows.length) this.db.prepare(`UPDATE instructions SET consumed=1 WHERE task_id=? AND consumed=0`).run(taskId);
    return rows.map((r) => r.text);
  }
  pendingInstructionCount(taskId: number): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM instructions WHERE task_id=? AND consumed=0').get(taskId) as any).n;
  }
  // ---- git marks of each attempt (see gitdiff.ts)
  beginAttemptGit(taskId: number, attempt: number, m: { head: string | null; snap: string } | null) {
    this.db.prepare('INSERT OR REPLACE INTO attempt_git(task_id,attempt,start_head,start_snap) VALUES(?,?,?,?)').run(taskId, attempt, m?.head ?? null, m?.snap ?? null);
  }
  endAttemptGit(taskId: number, attempt: number, m: { head: string | null; snap: string } | null) {
    this.db.prepare(`UPDATE attempt_git SET end_head=?, end_snap=?, ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=? AND attempt=?`).run(m?.head ?? null, m?.snap ?? null, taskId, attempt);
  }
  getAttemptGit(taskId: number, attempt: number): { startHead: string | null; startSnap: string | null; endHead: string | null; endSnap: string | null; ended: boolean } | null {
    const r = this.db.prepare('SELECT * FROM attempt_git WHERE task_id=? AND attempt=?').get(taskId, attempt) as any;
    return r ? { startHead: r.start_head, startSnap: r.start_snap, endHead: r.end_head, endSnap: r.end_snap, ended: !!r.ended_at } : null;
  }
  /** Attempts that have a git record, with their size of change if already computed (newest first). */
  attemptsWithGit(taskId: number): number[] {
    return (this.db.prepare('SELECT attempt FROM attempt_git WHERE task_id=? ORDER BY attempt DESC').all(taskId) as any[]).map((r) => r.attempt);
  }

  routeTasks(): RouteTask[] {
    return (this.db.prepare('SELECT t.id, t.name, t.dev_port, t.live_config, p.name AS project, p.alias AS alias, p.alias_task_id AS alias_task FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.dev_port IS NOT NULL OR t.live_config IS NOT NULL').all() as any[])
      .map((r) => {
        const live: LiveConfig | null = r.live_config ? JSON.parse(r.live_config) : null;
        return { id: r.id, name: r.name, project: r.project, alias: r.alias && r.alias_task === r.id ? (r.alias as string) : undefined, ports: live?.ports.length ? live.ports : r.dev_port ? [{ name: 'web', port: r.dev_port, primary: true }] : [] };
      });
  }
  nonTerminalTaskIds(): number[] {
    return (this.db.prepare(`SELECT id FROM tasks WHERE status IN ('starting','running','checking')`).all() as any[]).map((r) => r.id);
  }
  queuedTaskIds(): number[] {
    return (this.db.prepare(`SELECT id FROM tasks WHERE status='queued' ORDER BY id`).all() as any[]).map((r) => r.id);
  }
}
export { emptyUsage };
