import { spawn } from 'node:child_process';
import { chmodSync, chownSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

export interface GitResult { code: number; stdout: string; stderr: string }

const HARDEN = ['-c', 'safe.directory=*', '-c', 'credential.helper=', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.sshCommand=', '-c', 'diff.external=', '-c', 'protocol.ext.allow=never'];
const SAFE_CONFIG = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode)|user\.(name|email)|remote\..+\.(url|fetch)|branch\..+\.(remote|merge))$/;

export interface GitOpts { cwd?: string; token?: string | null; uid?: number; env?: Record<string, string>; untrusted?: boolean; url?: string }

async function sanitizeRepoConfig(repo: string, url?: string) {
  const dir = path.join(repo, '.git');
  const cfg = path.join(dir, 'config');
  if (!lstatSync(dir).isDirectory() || !lstatSync(cfg).isFile()) throw new Error('unexpected repository layout');
  const run = (args: string[]) => git(['config', '--file', cfg, ...args]);
  const list = await run(['--name-only', '--list']);
  if (list.code !== 0) throw new Error(`cannot read the repository configuration: ${list.stderr.trim()}`);
  for (const key of new Set(list.stdout.split('\n').filter(Boolean))) if (!SAFE_CONFIG.test(key)) await run(['--unset-all', key]);
  if (url) await run(['remote.origin.url', url]);
}

/** Run git on the host. The token is injected as an HTTP header (never written to .git/config). `untrusted` is for a repository the agent can write. */
export async function git(args: string[], o: GitOpts = {}): Promise<GitResult> {
  if (o.untrusted && o.cwd) {
    try { await sanitizeRepoConfig(o.cwd, o.url); } catch (e) { return { code: 1, stdout: '', stderr: String((e as Error).message) }; }
  }
  const pre = [...HARDEN];
  if (o.token) pre.push('-c', `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`);
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0 && o.uid !== undefined;
  const base: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: asRoot ? '/tmp' : (process.env.HOME ?? '/tmp') };
  if (process.env.LANG) base.LANG = process.env.LANG;
  return new Promise((resolve) => {
    const p = spawn('git', [...pre, ...args], {
      cwd: o.cwd, env: { ...base, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', ...(o.untrusted ? { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } : {}), ...o.env },
      ...(asRoot ? { uid: o.uid, gid: o.uid } : {}),
    });
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    let stdout = '', stderr = '';
    p.stdout.on('data', (b) => (stdout += b));
    p.stderr.on('data', (b) => (stderr += b));
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e) }));
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr: redact(stderr, o.token) }));
  });
}
const redact = (s: string, t?: string | null) => (t ? s.split(t).join('***') : s);

export async function gitOk(args: string[], o: GitOpts = {}): Promise<string> {
  const r = await git(args, o);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export async function detectDefaultBranch(url: string, token?: string | null): Promise<string> {
  const out = await gitOk(['ls-remote', '--symref', url, 'HEAD'], { token });
  const m = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(out);
  if (m) return m[1];
  return 'main';
}

export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function chownTree(dir: string, uid: number) {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  const walk = (p: string) => {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return;
      if (root) chownSync(p, uid, uid);
      else chmodSync(p, st.mode | (st.isDirectory() ? 0o777 : 0o666)); // dev/CI: daemon is not root, make it writable for the container user
    } catch { /* best effort */ }
    if (lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink()) for (const e of readdirSync(p)) walk(path.join(p, e));
  };
  walk(dir);
}

export async function createPullRequest(o: { token: string; owner: string; repo: string; head: string; base: string; title: string; body: string; fetchImpl?: typeof fetch }): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const res = await f(`https://api.github.com/repos/${o.owner}/${o.repo}/pulls`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${o.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'bivouac', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ title: o.title, head: o.head, base: o.base, body: o.body }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 422 && /already exists/i.test(JSON.stringify(j))) {
      const q = await f(`https://api.github.com/repos/${o.owner}/${o.repo}/pulls?head=${o.owner}:${encodeURIComponent(o.head)}&state=open`, { headers: { Authorization: `Bearer ${o.token}`, 'User-Agent': 'bivouac' } });
      const arr: any[] = await q.json().catch(() => []);
      if (arr[0]?.html_url) return arr[0].html_url;
    }
    throw new Error(`GitHub API ${res.status}: ${j.message ?? 'error'} ${j.errors ? JSON.stringify(j.errors) : ''}`);
  }
  return j.html_url as string;
}

/** Reads bivouac.yml from the tip of a branch without a full clone. Returns null when absent. */
export async function fetchRepoFile(url: string, branch: string, file: string, token?: string | null): Promise<string | null> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'bv-peek-'));
  try {
    const c = await git(['clone', '--quiet', '--depth', '1', '--no-checkout', '--filter=blob:none', '--branch', branch, url, dir], { token });
    if (c.code !== 0) throw new Error(`cannot read ${url} (branch ${branch}): ${c.stderr.trim()}`);
    const s = await git(['show', `HEAD:${file}`], { cwd: dir });
    return s.code === 0 ? s.stdout : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
