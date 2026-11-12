import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiffFile, DiffPatch, DiffSummary, GitMark } from '@bivouac/shared';
import { git } from './git.js';

/** What a caller may name as a side of a diff: a full commit id (a mark) or the remote-tracking branch the task started from. */
const REF_RE = /^(?:[0-9a-f]{40}|origin\/[A-Za-z0-9._/-]{1,150})$/;
export function checkRef(ref: string): string {
  if (!REF_RE.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.includes('//')) throw new Error(`bad revision: ${ref}`);
  return ref;
}

type GitOpts = { cwd: string; uid: number; untrusted: true };
const AUTHOR = { GIT_AUTHOR_NAME: 'bivouac', GIT_AUTHOR_EMAIL: 'bivouac@localhost', GIT_COMMITTER_NAME: 'bivouac', GIT_COMMITTER_EMAIL: 'bivouac@localhost' };

/**
 * Records the state of a task repository: its HEAD and a snapshot commit of the whole working tree (committed, staged,
 * unstaged and untracked files, ignored files and `.bivouac` excluded). The snapshot is built with a throwaway index so the
 * agent's own staging area is untouched, and pinned by a ref so garbage collection cannot remove it. Diffing two snapshots
 * gives everything that changed between two moments, whether or not the agent committed it.
 */
export async function markState(o: GitOpts): Promise<GitMark | null> {
  const headR = await git(['rev-parse', '--verify', '-q', 'HEAD'], o);
  const head = headR.code === 0 ? headR.stdout.trim() : null;
  const idx = path.join(tmpdir(), `bv-mark-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: idx, ...AUTHOR };
  try {
    if (head && (await git(['read-tree', 'HEAD'], { ...o, env })).code !== 0) return null;
    if ((await git(['add', '-A', '--', '.', ':!.bivouac'], { ...o, env })).code !== 0) return null;
    const tree = await git(['write-tree'], { ...o, env });
    if (tree.code !== 0) return null;
    const commit = await git(['commit-tree', tree.stdout.trim(), '-m', 'bivouac snapshot'], { ...o, env });
    if (commit.code !== 0) return null;
    const snap = commit.stdout.trim();
    await git(['update-ref', `refs/bivouac/marks/${snap}`, snap], o);
    return { head, snap };
  } finally { rmSync(idx, { force: true }); }
}

/** `git diff` outputs paths NUL-separated; C-quoting is off with -z. */
function parseNameStatus(out: string): Map<string, { status: DiffFile['status']; oldPath?: string }> {
  const parts = out.split('\0').filter((s) => s !== '');
  const m = new Map<string, { status: DiffFile['status']; oldPath?: string }>();
  for (let i = 0; i < parts.length;) {
    const code = parts[i++][0];
    if (code === 'R' || code === 'C') { const oldPath = parts[i++]; const p = parts[i++]; m.set(p, { status: 'renamed', oldPath }); }
    else { const p = parts[i++]; m.set(p, { status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' }); }
  }
  return m;
}
function parseNumstat(out: string): { path: string; oldPath?: string; added: number; deleted: number; binary: boolean }[] {
  const res: { path: string; oldPath?: string; added: number; deleted: number; binary: boolean }[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length;) {
    const head = parts[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const binary = m[1] === '-';
    if (m[3] === '') { const oldPath = parts[i++]; const p = parts[i++]; res.push({ path: p, oldPath, added: binary ? 0 : +m[1], deleted: binary ? 0 : +m[2], binary }); }
    else res.push({ path: m[3], added: binary ? 0 : +m[1], deleted: binary ? 0 : +m[2], binary });
  }
  return res;
}

/** The files that differ between two revisions, with line counts, and the commits that lie between two heads. */
export async function diffSummary(o: GitOpts, from: string, to: string, heads?: { from: string | null; to: string | null }): Promise<DiffSummary> {
  checkRef(from); checkRef(to);
  const [ns, num] = await Promise.all([
    git(['diff', '--name-status', '-z', '-M', '--no-color', from, to], o),
    git(['diff', '--numstat', '-z', '-M', '--no-color', from, to], o),
  ]);
  if (ns.code !== 0 || num.code !== 0) throw new Error(`git diff failed: ${(ns.stderr || num.stderr).trim()}`);
  const status = parseNameStatus(ns.stdout);
  const files: DiffFile[] = parseNumstat(num.stdout).map((f) => {
    const s = status.get(f.path);
    return { path: f.path, ...(s?.oldPath ?? f.oldPath ? { oldPath: s?.oldPath ?? f.oldPath } : {}), status: s?.status ?? 'modified', added: f.added, deleted: f.deleted, binary: f.binary };
  }).sort((a, b) => a.path.localeCompare(b.path));
  let commits: DiffSummary['commits'] = [];
  if (heads?.to && heads.from !== heads.to) {
    const range = heads.from ? `${checkRef(heads.from)}..${checkRef(heads.to)}` : checkRef(heads.to);
    const log = await git(['log', '--format=%H%x09%s', '--max-count=50', range], o);
    if (log.code === 0) commits = log.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; });
  }
  return { files, commits, totals: { files: files.length, added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0) } };
}

const MAX_PATCH_BYTES = 4_000_000;
const MAX_LINE = 2000;
/** The patch of one file (or of the whole change when no path is given), cut into lines so a caller can read it a window at a time (`offset`, `limit` in lines). */
export async function diffPatch(o: GitOpts, from: string, to: string, paths: string[], offset: number, limit: number): Promise<DiffPatch> {
  checkRef(from); checkRef(to);
  const clean = paths.filter((p) => p && !p.includes('\0'));
  // no path: the whole diff, file after file
  const r = await git(['diff', '--no-color', '-M', '-U3', '--no-ext-diff', '--no-textconv', from, to, ...(clean.length ? ['--', ...clean] : [])], o);
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  let text = r.stdout, cut = false;
  if (Buffer.byteLength(text) > MAX_PATCH_BYTES) { text = text.slice(0, MAX_PATCH_BYTES); cut = true; }
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  const binary = all.some((l) => /^Binary files .* differ$/.test(l) || l.startsWith('GIT binary patch'));
  const start = Math.max(0, Math.trunc(offset)), n = Math.min(Math.max(Math.trunc(limit), 1), 5000);
  const lines = all.slice(start, start + n).map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + ' …(line cut)' : l));
  return { lines, offset: start, total: all.length, truncated: start + n < all.length || cut, binary, nextOffset: start + n < all.length ? start + n : null };
}
