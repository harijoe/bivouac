import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { emptyUsage, type EventKind, type Project, type ProjectConfig, type Task, type TaskEvent, type TaskStatus, type Usage } from '@bivouac/shared';
import { decrypt, encrypt } from './crypto.js';

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
CREATE TABLE IF NOT EXISTS instructions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, text TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
`;

export type StoreMessage = { type: 'task'; task: Task } | { type: 'event'; event: TaskEvent } | { type: 'project'; projectId: number };

export class Store {
  readonly db: Database.Database;
  readonly bus = new EventEmitter();
  /** Resolves the preview URL for a task row (injected so the store stays config-free). */
  previewUrlFor: (project: string, taskId: number) => string = () => '';

  constructor(path: string, private key: Buffer) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.bus.setMaxListeners(200);
  }

  // ---- settings
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
    return { id: r.id, name: r.name, repoUrl: r.repo_url, defaultBranch: r.default_branch, hasGithubToken: !!r.github_token_enc, config: JSON.parse(r.config_json), createdAt: r.created_at };
  }
  createProject(p: { name: string; repoUrl: string; defaultBranch: string; githubToken?: string | null; config?: ProjectConfig }): Project {
    const info = this.db.prepare('INSERT INTO projects(name,repo_url,default_branch,github_token_enc,config_json) VALUES(?,?,?,?,?)')
      .run(p.name, p.repoUrl, p.defaultBranch, p.githubToken ? encrypt(this.key, p.githubToken) : null, JSON.stringify(p.config ?? {}));
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
    const usage: Usage = { inputTokens: r.in_tok, outputTokens: r.out_tok, cacheReadTokens: r.cache_read, cacheCreationTokens: r.cache_create, costUsd: r.cost_usd };
    return {
      id: r.id, projectId: r.project_id, projectName: r.project_name, title: r.title, prompt: r.prompt, successCommand: r.success_command,
      branch: r.branch, baseBranch: r.base_branch, status: r.status, iteration: r.iteration, maxIterations: r.max_iterations,
      maxCostUsd: r.max_cost_usd, maxTokens: r.max_tokens, sessionId: r.session_id, usage,
      previewUrl: this.previewUrlFor(r.project_name, r.id), publicPreview: !!r.public_preview, pushed: !!r.pushed, prUrl: r.pr_url, error: r.error,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    };
  }
  private static TASK_SELECT = 'SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id';
  createTask(t: { projectId: number; title: string; prompt: string; successCommand: string; baseBranch: string; maxIterations: number; maxCostUsd: number; maxTokens?: number | null; publicPreview?: boolean; previewUser?: string; previewPass?: string }, slugFor: (id: number) => string): Task {
    const tx = this.db.transaction(() => {
      const info = this.db.prepare('INSERT INTO tasks(project_id,title,prompt,success_command,branch,base_branch,status,max_iterations,max_cost_usd,max_tokens,public_preview,preview_user,preview_pass_enc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(t.projectId, t.title, t.prompt, t.successCommand, 'pending', t.baseBranch, 'queued', t.maxIterations, t.maxCostUsd, t.maxTokens ?? null,
          t.publicPreview ? 1 : 0, t.previewUser ?? null, t.previewPass ? encrypt(this.key, t.previewPass) : null);
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
  getPreviewAuth(id: number): { user: string; pass: string } | null {
    const r = this.db.prepare('SELECT preview_user, preview_pass_enc FROM tasks WHERE id=?').get(id) as any;
    return r?.preview_pass_enc ? { user: r.preview_user, pass: decrypt(this.key, r.preview_pass_enc) } : null;
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
    const terminal = ['succeeded', 'failed', 'budget_exceeded', 'max_iterations', 'stopped'].includes(status);
    this.db.prepare(`UPDATE tasks SET status=?, error=?, started_at=CASE WHEN ? AND started_at IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE started_at END, finished_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=?`)
      .run(status, error ?? null, status === 'starting' ? 1 : 0, terminal ? 1 : 0, id);
    this.addEvent(id, 'status', { status, error: error ?? null });
    return this.emitTask(id)!;
  }
  patchTask(id: number, p: Partial<{ iteration: number; sessionId: string; pushed: boolean; prUrl: string; maxIterations: number; maxCostUsd: number; maxTokens: number | null; error: string | null }>) {
    const m: Record<string, string> = { iteration: 'iteration', sessionId: 'session_id', pushed: 'pushed', prUrl: 'pr_url', maxIterations: 'max_iterations', maxCostUsd: 'max_cost_usd', maxTokens: 'max_tokens', error: 'error' };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      this.db.prepare(`UPDATE tasks SET ${m[k]}=? WHERE id=?`).run(typeof v === 'boolean' ? (v ? 1 : 0) : v, id);
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
  nonTerminalTaskIds(): number[] {
    return (this.db.prepare(`SELECT id FROM tasks WHERE status IN ('starting','running','checking')`).all() as any[]).map((r) => r.id);
  }
  queuedTaskIds(): number[] {
    return (this.db.prepare(`SELECT id FROM tasks WHERE status='queued' ORDER BY id`).all() as any[]).map((r) => r.id);
  }
}
export { emptyUsage };
