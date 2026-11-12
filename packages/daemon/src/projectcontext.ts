import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { mergeConfig, parseProjectConfig, type Project, type Task } from '@bivouac/shared';
import type { DaemonConfig } from './config.js';
import type { Store } from './db.js';
import { git, gitOk, parseGithubRepo } from './git.js';

/** Budget of the default snapshot, in characters (about 10 000 tokens). */
export const SNAPSHOT_CHARS = 40_000;
export const MAX_FILE_CHARS = 60_000;
const DOCS = ['README.md', 'README', 'README.rst', 'CLAUDE.md', 'AGENTS.md', 'PROGRESS.md', 'NOTES.md', 'docs/decisions.md', 'CHANGELOG.md'];
const DOC_BUDGET: Record<string, number> = { 'README.md': 5000, README: 5000, 'README.rst': 5000, 'CLAUDE.md': 3000, 'AGENTS.md': 3000, 'PROGRESS.md': 4000, 'NOTES.md': 2500, 'docs/decisions.md': 2500, 'CHANGELOG.md': 2000 };

// ---- secrets: never part of the output
const SECRET_NAME = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?$/i, /\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /(^|\/)\.(npmrc|netrc|pypirc|git-credentials)$/,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i, /(^|\/)\.aws\//, /(^|\/)\.ssh\//, /(^|\/)terraform\.tfstate/, /(^|\/)\.docker\/config\.json$/,
];
const NOISE_DIRS = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|coverage|vendor|target|__pycache__|\.venv|\.git|\.turbo|\.cache)(\/|$)/;
export const isSecretPath = (p: string) => SECRET_NAME.some((r) => r.test(p));

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
/** `password: hunter2hunter2`, `API_KEY="..."`: keeps the name, hides the value. */
const KEY_VALUE = /\b([A-Za-z_]*(?:authorization|password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)[A-Za-z_]*)(\s*[:=]\s*)(["']?)[A-Za-z0-9+/=_-]{12,}\3/gi;
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  return out.replace(KEY_VALUE, (_m, name, sep) => `${name}${sep}[redacted]`);
}

/** Minimal .gitignore matcher (root file only): enough to keep ignored files that were force-added out of the snapshot. */
export function gitignoreMatcher(text: string | null): (p: string) => boolean {
  const rules: { re: RegExp; neg: boolean }[] = [];
  for (const raw of (text ?? '').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    if (neg) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    line = line.replace(/\/$/, '');
    const anchored = line.includes('/') && !line.startsWith('**/');
    line = line.replace(/^\//, '');
    const body = line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    rules.push({ neg, re: new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}${dirOnly ? '/' : '(?:/|$)'}`) });
  }
  return (p) => { let ignored = false; for (const r of rules) if (r.re.test(p + (p.endsWith('/') ? '' : '/')) || r.re.test(p)) ignored = !r.neg; return ignored; };
}

/** Service environment variables are mostly credentials: show their names, never their values. */
export function hideEnvValues<T extends { services?: Record<string, { env?: Record<string, string> }> }>(cfg: T): T {
  if (!cfg.services) return cfg;
  const services = Object.fromEntries(Object.entries(cfg.services).map(([n, sv]) => [n, sv.env ? { ...sv, env: Object.fromEntries(Object.keys(sv.env).map((k) => [k, '[hidden]'])) } : sv]));
  return { ...cfg, services };
}

/** Keeps the start and the end of a text: the start says what it is, the end says where it stopped. */
export function truncateSmart(text: string, max: number, hint = 'use read_project_file for the full file'): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65), tail = max - head;
  return `${text.slice(0, head).trimEnd()}\n[… ${text.length - max} characters omitted; ${hint} …]\n${text.slice(-tail).trimStart()}`;
}

export interface FileEntry { path: string; size: number }
const LANGS: Record<string, string> = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', php: 'PHP', cs: 'C#', c: 'C', h: 'C', cpp: 'C++', swift: 'Swift', sh: 'Shell', css: 'CSS', scss: 'CSS', html: 'HTML', vue: 'Vue', svelte: 'Svelte', sql: 'SQL', md: 'Markdown', yml: 'YAML', yaml: 'YAML', json: 'JSON' };

/** Compact structure of the repository: main folders, languages and sizes, no file contents. */
export function summarizeTree(files: FileEntry[], depth = 2, maxLines = 60): string {
  const ok = files.filter((f) => !NOISE_DIRS.test(f.path));
  const langs = new Map<string, number>();
  for (const f of ok) { const l = LANGS[f.path.split('.').pop()?.toLowerCase() ?? '']; if (l && l !== 'JSON' && l !== 'Markdown' && l !== 'YAML') langs.set(l, (langs.get(l) ?? 0) + f.size); }
  const total = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
  const dirs = new Map<string, { files: number; bytes: number }>();
  for (const f of ok) {
    const parts = f.path.split('/');
    const key = parts.length === 1 ? '.' : parts.slice(0, Math.min(depth, parts.length - 1)).join('/') + '/';
    const d = dirs.get(key) ?? { files: 0, bytes: 0 };
    d.files++; d.bytes += f.size; dirs.set(key, d);
  }
  const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const lines = [
    `${ok.length} files (${kb(ok.reduce((a, f) => a + f.size, 0))}); languages: ${[...langs].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l, b]) => `${l} ${Math.round((b / total) * 100)}%`).join(', ') || 'n/a'}`,
    ...[...dirs].sort((a, b) => a[0].localeCompare(b[0])).slice(0, maxLines).map(([d, v]) => `- ${d}  (${v.files} files, ${kb(v.bytes)})`),
  ];
  if (dirs.size > maxLines) lines.push(`- … ${dirs.size - maxLines} more folders`);
  return lines.join('\n');
}

export type PrState = 'open' | 'merged' | 'closed' | 'unknown' | 'none';

/** Read-only view of a project for planning: git mirror (kept up to date by the daemon) + the bivouac database. */
export class ProjectContext {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private store: Store, private cfg: DaemonConfig, private readToken: (p: Project) => Promise<string | null>, private fetchImpl: typeof fetch = fetch) {}

  private mirrorDir(p: Project) { return path.join(this.cfg.dataDir, 'mirrors', `${p.name}.git`); }
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    return next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); });
  }

  /** Fetches the repository into a bare mirror with the repo-limited token. A failed fetch falls back to the last mirror. */
  async sync(p: Project): Promise<{ dir: string; warning: string | null }> {
    return this.serial(p.name, async () => {
      const dir = this.mirrorDir(p);
      const token = await this.readToken(p).catch(() => null);
      mkdirSync(path.dirname(dir), { recursive: true });
      try {
        if (!existsSync(path.join(dir, 'HEAD'))) {
          await gitOk(['init', '--bare', '--quiet', dir]);
          await gitOk(['remote', 'add', 'origin', p.repoUrl], { cwd: dir });
        }
        await gitOk(['fetch', '--quiet', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: dir, token });
        return { dir, warning: null };
      } catch (e: any) {
        if (existsSync(path.join(dir, 'HEAD')) && (await git(['rev-parse', '--verify', '-q', p.defaultBranch], { cwd: dir })).code === 0) {
          return { dir, warning: `Could not refresh the repository (${String(e?.message ?? e).split('\n')[0]}): the code and history below may be out of date.` };
        }
        throw new Error(`Could not read the repository ${p.githubRepo ?? p.repoUrl}: ${String(e?.message ?? e).split('\n')[0]}`);
      }
    });
  }

  private async show(dir: string, ref: string, file: string, max: number): Promise<string | null> {
    const size = await git(['cat-file', '-s', `${ref}:${file}`], { cwd: dir });
    if (size.code !== 0) return null;
    const n = Number(size.stdout.trim());
    const r = await git(['cat-file', 'blob', `${ref}:${file}`], { cwd: dir });
    if (r.code !== 0) return null;
    if (r.stdout.includes('\0')) return '[binary file]';
    void n;
    return r.stdout.length > max * 4 ? r.stdout.slice(0, max * 4) : r.stdout;
  }

  private async tree(dir: string, ref: string): Promise<FileEntry[]> {
    const r = await git(['ls-tree', '-r', '-l', '--full-tree', ref], { cwd: dir });
    if (r.code !== 0) return [];
    const ignored = gitignoreMatcher(await this.show(dir, ref, '.gitignore', 20_000));
    const out: FileEntry[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^\d+ blob [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(line);
      if (m && !isSecretPath(m[2]) && !ignored(m[2])) out.push({ path: m[2], size: m[1] === '-' ? 0 : Number(m[1]) });
    }
    return out;
  }

  /** Content of one file. Refuses secrets and git-ignored files, redacts token-like strings, caps the size. */
  async readFile(p: Project, file: string, ref?: string): Promise<{ path: string; ref: string; content: string; truncated: boolean }> {
    if (!file || file.startsWith('/') || file.split('/').includes('..') || file.includes('\0') || file.startsWith('-')) throw new Error(`"${file}" is not a valid path inside the repository (use a relative path such as src/index.ts).`);
    const r = ref ?? p.defaultBranch;
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(r) || r.startsWith('-')) throw new Error(`"${r}" is not a valid branch, tag or commit.`);
    if (isSecretPath(file)) throw new Error(`"${file}" looks like a secret (credentials, keys, .env): bivouac does not show it.`);
    const { dir } = await this.sync(p);
    const ignored = gitignoreMatcher(await this.show(dir, r, '.gitignore', 20_000));
    if (ignored(file)) throw new Error(`"${file}" is ignored by git in this repository: bivouac does not show it.`);
    const text = await this.show(dir, r, file, MAX_FILE_CHARS);
    if (text === null) throw new Error(`"${file}" does not exist on ${r}. Use get_project_context to see the repository structure.`);
    const red = redactSecrets(text);
    return { path: file, ref: r, content: red.length > MAX_FILE_CHARS ? red.slice(0, MAX_FILE_CHARS) : red, truncated: red.length > MAX_FILE_CHARS };
  }

  private async prState(p: Project, t: Task): Promise<PrState> {
    if (!t.prUrl) return 'none';
    const gh = parseGithubRepo(p.repoUrl);
    const num = /\/pull\/(\d+)/.exec(t.prUrl)?.[1];
    const token = await this.readToken(p).catch(() => null);
    if (!gh || !num || !token) return 'unknown';
    try {
      const r = await this.fetchImpl(`https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls/${num}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'bivouac' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return 'unknown';
      const j: any = await r.json();
      return j.merged ? 'merged' : j.state === 'open' ? 'open' : 'closed';
    } catch { return 'unknown'; }
  }

  private filesTouched(taskId: number): string[] {
    const set = new Set<string>();
    for (const e of this.store.lastEvents(taskId, 'tool_use', 100_000)) {
      const fp = e.data?.input?.file_path ?? e.data?.input?.path;
      if (typeof fp === 'string' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.data?.name)) set.add(fp.replace(/^\/workspace\/repo\//, ''));
    }
    return [...set].filter((f) => !isSecretPath(f));
  }

  private async taskSection(p: Project, t: Task, full: boolean, withPr = true): Promise<{ text: string; problem: string | null }> {
    const msgs = this.store.lastEvents(t.id, 'assistant_text', 6).map((e) => String(e.data.text ?? ''));
    const last = this.store.lastEvents(t.id, 'check', 1)[0];
    const files = this.filesTouched(t.id);
    const pr = withPr ? await this.prState(p, t) : 'none';
    const cost = `$${t.usage.costUsd.toFixed(2)}`;
    const lines = [
      `#### ${t.name} — ${t.status}${t.error ? ` (${redactSecrets(t.error).slice(0, 200)})` : ''}`,
      `- branch \`${t.branch}\`${t.pushed ? ' (pushed)' : ' (not pushed)'}; PR: ${pr === 'none' ? 'none' : `${pr}${t.prUrl ? ` ${t.prUrl}` : ''}`}; iteration ${t.iteration}/${t.maxIterations}; cost ${cost}/${t.maxCostUsd}`,
      `- prompt: ${redactSecrets(full ? t.prompt : truncateSmart(t.prompt, 600, 'ask for detail "task:' + t.name + '"'))}`,
      `- agent's last message: ${msgs.length ? redactSecrets(truncateSmart(msgs[msgs.length - 1], full ? 4000 : 700, 'detail "task:' + t.name + '"')) : '(none yet)'}`,
      `- files changed (${files.length}): ${files.slice(0, full ? 100 : 12).join(', ') || 'none'}${files.length > (full ? 100 : 12) ? ', …' : ''}`,
      `- last verification: ${last ? `\`${last.data.command}\` → exit ${last.data.exitCode}${last.data.exitCode ? `\n\`\`\`\n${redactSecrets(String(last.data.output ?? '').slice(full ? -3000 : -500))}\n\`\`\`` : ''}` : 'not run yet'}`,
    ];
    if (full && msgs.length > 1) lines.push('- earlier agent messages:', ...msgs.slice(-6, -1).map((m) => `  - ${redactSecrets(m.slice(0, 500)).replace(/\n/g, ' ')}`));
    let problem: string | null = null;
    if (t.status === 'budget_exceeded') problem = `task "${t.name}" stopped on its budget (${cost} of ${t.maxCostUsd})`;
    else if (last && last.data.exitCode !== 0 && ['failed', 'max_iterations', 'stopped', 'stuck'].includes(t.status)) problem = `task "${t.name}" ended (${t.status}) with its verification failing: \`${last.data.command}\` exit ${last.data.exitCode}`;
    else if (t.status === 'failed') problem = `task "${t.name}" failed: ${redactSecrets(t.error ?? 'unknown error').slice(0, 200)}`;
    return { text: lines.join('\n'), problem };
  }

  /**
   * A snapshot of the project for a model that has to plan the next step.
   * detail: undefined (compact overview) | "task:<name>" | "doc:<path>" | "tree" | "commits".
   */
  async snapshot(p: Project, detail?: string): Promise<string> {
    const { dir, warning } = await this.sync(p);
    const ref = p.defaultBranch;
    const head = await gitOk(['log', '-1', '--format=%h %s (%an, %ad)', '--date=short', ref], { cwd: dir }).catch(() => '');
    if (!head) throw new Error(`The repository has no commit on ${ref} yet.`);
    const out: string[] = [];
    const d = (detail ?? '').trim();

    if (d.startsWith('task:')) {
      const t = this.store.getTaskByName(p.id, d.slice(5));
      if (!t) throw new Error(`No task "${d.slice(5)}" in ${p.name}. Tasks: ${this.store.listTasks(p.id).map((x) => x.name).join(', ') || 'none'}.`);
      return `# Task ${t.name} of ${p.name}\n\n${(await this.taskSection(p, t, true)).text}\n\nFull prompt:\n${redactSecrets(t.prompt)}`;
    }
    if (d.startsWith('doc:')) {
      const f = await this.readFile(p, d.slice(4), ref);
      return `# ${f.path} (${p.name}, ${ref})${f.truncated ? ' — truncated' : ''}\n\n${f.content}`;
    }
    if (d === 'tree') return `# Structure of ${p.name} (${ref})\n\n${summarizeTree(await this.tree(dir, ref), 3, 200)}`;
    if (d === 'commits') {
      const log = await gitOk(['log', '-n', '60', '--format=%h %ad %an: %s', '--date=short', ref], { cwd: dir });
      return `# Recent commits on ${ref} (${p.name})\n\n${redactSecrets(log)}`;
    }
    if (d) throw new Error(`Unknown detail "${d}". Use "task:<task name>", "doc:<path>", "tree" or "commits", or leave it empty for the overview.`);

    out.push(`# Project ${p.name}`, ...(warning ? [`> ${warning}`] : []), '');
    out.push(`- repository: ${p.githubRepo ?? p.repoUrl}`, `- default branch: ${ref}`, `- last commit: ${redactSecrets(head.trim())}`);
    let repoCfg = {};
    const cfgText = await this.show(dir, ref, 'bivouac.yml', 20_000);
    if (cfgText) try { repoCfg = parseProjectConfig(cfgText); } catch { /* reported below */ }
    out.push('', '## Effective bivouac.yml (repository file + dashboard overrides)', '```json', JSON.stringify(hideEnvValues(mergeConfig(repoCfg, p.config)), null, 1), '```');
    if (cfgText) try { parseProjectConfig(cfgText); } catch (e: any) { out.push(`> bivouac.yml on ${ref} is invalid: ${e.message}`); }

    out.push('', '## Documentation');
    const ignored = gitignoreMatcher(await this.show(dir, ref, '.gitignore', 20_000));
    let any = false;
    for (const f of DOCS) {
      if (isSecretPath(f) || ignored(f)) continue;
      const t = await this.show(dir, ref, f, 20_000);
      if (t === null) continue;
      any = true;
      out.push('', `### ${f}`, redactSecrets(truncateSmart(t, DOC_BUDGET[f] ?? 2000, `ask for detail "doc:${f}"`)));
    }
    if (!any) out.push('(no README or project notes found)');

    out.push('', '## Code structure', summarizeTree(await this.tree(dir, ref)));
    const log = await gitOk(['log', '-n', '12', '--format=- %h %ad %s', '--date=short', ref], { cwd: dir }).catch(() => '');
    out.push('', `## Recent commits on ${ref}`, redactSecrets(log.trim()) || '(none)');

    const tasks = this.store.listTasks(p.id);
    const shown = tasks.slice(0, 8);
    out.push('', `## Tasks (${shown.length} of ${tasks.length}, newest first)`);
    const problems: string[] = [];
    if (!shown.length) out.push('No task yet. A first task can be started with create_task.');
    for (const t of tasks) {
      const s = await this.taskSection(p, t, false, shown.includes(t));
      if (s.problem) problems.push(s.problem);
      if (shown.includes(t)) out.push('', s.text);
    }
    out.push('', '## Known problems', ...(problems.length ? problems.slice(0, 10).map((x) => `- ${x}`) : ['None recorded.']));
    out.push('', `_Ask for more with detail: "task:<name>", "doc:<path>", "tree", "commits"; read any file with read_project_file._`);
    return truncateSmart(out.join('\n'), SNAPSHOT_CHARS * 1.25, 'ask for a narrower detail');
  }
}
