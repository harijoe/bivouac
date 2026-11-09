import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { emptyUsage, TERMINAL_STATUSES, type PortDef, type ServiceConfig, type EventKind, type Project, type ProjectConfig, type Task, type TaskEvent, type TaskStatus, type Usage } from '@bivouac/shared';
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
    return { id: r.id, name: r.name, repoUrl: r.repo_url, githubRepo: r.github_repo ?? null, installationId: r.installation_id ?? null, defaultBranch: r.default_branch, hasGithubToken: !!r.github_token_enc, config: JSON.parse(r.config_json), createdAt: r.created_at };
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
  updateProject(id: number, patch: { config?: ProjectConfig; githubToken?: string | null; defaultBranch?: string }) {
    if (patch.config !== undefined) this.db.prepare('UPDATE projects SET config_json=? WHERE id=?').run(JSON.stringify(patch.config), id);
    if (patch.githubToken !== undefined) this.db.prepare('UPDATE projects SET github_token_enc=? WHERE id=?').run(patch.githubToken ? encrypt(this.key, patch.githubToken) : null, id);
    if (patch.defaultBranch) this.db.prepare('UPDATE projects SET default_branch=? WHERE id=?').run(patch.defaultBranch, id);
    this.bus.emit('msg', { type: 'project', projectId: id } satisfies StoreMessage);
  }
  deleteProject(id: number) {
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    this.bus.emit('msg', { type: 'project', projectId: id } satisfies StoreMessage);
  }

  // ---- tasks
  private taskFromRow(r: any): Task {
    const live: LiveConfig = r.live_config ? JSON.parse(r.live_config) : { ports: [], services: {}, error: null };
    const livePorts: PortDef[] = live.ports.length ? live.ports : r.dev_port ? [{ name: 'web', port: r.dev_port, primary: true }] : [];
    const ports = livePorts.map((p) => ({ ...p, url: this.previewUrlFor(r.project_name, r.name, p.primary ? undefined : p.name) }));
    const usage: Usage = { inputTokens: r.in_tok, outputTokens: r.out_tok, cacheReadTokens: r.cache_read, cacheCreationTokens: r.cache_create, costUsd: r.cost_usd };
    return {
      id: r.id, projectId: r.project_id, projectName: r.project_name, name: r.name, title: r.title, prompt: r.prompt, successCommand: r.success_command,
      branch: r.branch, baseBranch: r.base_branch, status: r.status, iteration: r.iteration, maxIterations: r.max_iterations,
      maxCostUsd: r.max_cost_usd, maxTokens: r.max_tokens, sessionId: r.session_id, usage,
      devPort: r.dev_port ?? null, ports, services: Object.entries(live.services).map(([name, v]) => ({ name, image: v.image })), configError: live.error, previewUrl: this.previewUrlFor(r.project_name, r.name), pushed: !!r.pushed, prUrl: r.pr_url, error: r.error,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    };
  }
  private static TASK_SELECT = 'SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id';
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
  patchTask(id: number, p: Partial<{ devPort: number; liveConfig: LiveConfig; iteration: number; sessionId: string; pushed: boolean; prUrl: string; maxIterations: number; maxCostUsd: number; maxTokens: number | null; error: string | null }>) {
    const m: Record<string, string> = { liveConfig: 'live_config', devPort: 'dev_port', iteration: 'iteration', sessionId: 'session_id', pushed: 'pushed', prUrl: 'pr_url', maxIterations: 'max_iterations', maxCostUsd: 'max_cost_usd', maxTokens: 'max_tokens', error: 'error' };
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
  deleteTask(id: number) {
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    this.bus.emit('msg', { type: 'project', projectId: 0 } satisfies StoreMessage);
  }
  totals(projectId?: number): Usage & { tasks: number } {
    const r = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(in_tok),0) i, COALESCE(SUM(out_tok),0) o, COALESCE(SUM(cache_read),0) cr, COALESCE(SUM(cache_create),0) cc, COALESCE(SUM(cost_usd),0) c FROM tasks ${projectId ? 'WHERE project_id=?' : ''}`).get(...(projectId ? [projectId] : [])) as any;
    return { tasks: r.n, inputTokens: r.i, outputTokens: r.o, cacheReadTokens: r.cr, cacheCreationTokens: r.cc, costUsd: r.c };
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
  routeTasks(): RouteTask[] {
    return (this.db.prepare('SELECT t.id, t.name, t.dev_port, t.live_config, p.name AS project FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.dev_port IS NOT NULL OR t.live_config IS NOT NULL').all() as any[])
      .map((r) => {
        const live: LiveConfig | null = r.live_config ? JSON.parse(r.live_config) : null;
        return { id: r.id, name: r.name, project: r.project, ports: live?.ports.length ? live.ports : r.dev_port ? [{ name: 'web', port: r.dev_port, primary: true }] : [] };
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
