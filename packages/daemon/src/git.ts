import { spawn } from 'node:child_process';
import { chownSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

export interface GitResult { code: number; stdout: string; stderr: string }

/** Run git on the host. The token is injected as an HTTP header (never written to .git/config). */
export function git(args: string[], o: { cwd?: string; token?: string | null; uid?: number } = {}): Promise<GitResult> {
  const pre = ['-c', 'safe.directory=*', '-c', 'credential.helper='];
  if (o.token) pre.push('-c', `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`);
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0 && o.uid !== undefined;
  return new Promise((resolve) => {
    const p = spawn('git', [...pre, ...args], {
      cwd: o.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(asRoot ? { HOME: '/tmp' } : {}) },
      ...(asRoot ? { uid: o.uid, gid: o.uid } : {}),
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (b) => (stdout += b));
    p.stderr.on('data', (b) => (stderr += b));
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e) }));
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr: redact(stderr, o.token) }));
  });
}
const redact = (s: string, t?: string | null) => (t ? s.split(t).join('***') : s);

export async function gitOk(args: string[], o: Parameters<typeof git>[1] = {}): Promise<string> {
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
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const walk = (p: string) => {
    chownSync(p, uid, uid);
    if (lstatSync(p).isDirectory()) for (const e of readdirSync(p)) walk(path.join(p, e));
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
