import type { AttemptShots, DiffFile, Shot } from '@bivouac/shared';

// ---------- diff lines
export type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

/**
 * Kinds of the lines of one window of a unified diff. Lines before the first `@@` are file headers (`---`, `+++`, `index`…):
 * `inHunk` carries that across windows, so a deleted line that starts with `--` is never mistaken for a header.
 */
export function classifyPatch(lines: string[], inHunk = false): { kinds: LineKind[]; inHunk: boolean } {
  const kinds: LineKind[] = [];
  for (const l of lines) {
    if (l.startsWith('@@')) { inHunk = true; kinds.push('hunk'); }
    else if (!inHunk) kinds.push('meta');
    else if (l.startsWith('\\')) kinds.push('meta');
    else if (l.startsWith('+')) kinds.push('add');
    else if (l.startsWith('-')) kinds.push('del');
    else kinds.push('ctx');
  }
  return { kinds, inHunk };
}

export const LINE_CLASS: Record<LineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  del: 'bg-red-500/10 text-red-800 dark:text-red-300',
  hunk: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  meta: 'text-muted-foreground',
  ctx: '',
};

/** "3 files, +40 −12" */
export function diffHeadline(t: { files: number; added: number; deleted: number }): string {
  return `${t.files} ${t.files === 1 ? 'file' : 'files'}, +${t.added} −${t.deleted}`;
}
/** Where the changes are: committed, only in the working tree, or both. */
export function diffOrigin(d: { committed: boolean; uncommitted: boolean; commits: unknown[] }): string | null {
  if (!d.committed && d.uncommitted) return 'Uncommitted changes only';
  if (d.committed && d.uncommitted) return 'Includes changes the agent did not commit';
  return d.commits.length ? `${d.commits.length} ${d.commits.length === 1 ? 'commit' : 'commits'}` : null;
}
export const fileLabel = (f: DiffFile): string => (f.status === 'renamed' && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);
/** Size of the next window to load, and how many lines are still hidden after the shown ones. */
export function nextWindow(total: number, nextOffset: number | null, limit = 400): { next: number; hidden: number } {
  const hidden = nextOffset === null ? 0 : Math.max(0, total - nextOffset);
  return { next: Math.min(limit, hidden), hidden };
}

// ---------- screenshots
export interface ShotBadge { label: string; bad: boolean }
/** The problems of a shot as short badges; a clean page gives a single "OK". */
export function shotBadges(s: Shot): ShotBadge[] {
  const out: ShotBadge[] = [];
  if (s.httpStatus !== null && s.httpStatus >= 400) out.push({ label: `HTTP ${s.httpStatus}`, bad: true });
  if (s.blank) out.push({ label: 'Blank page', bad: true });
  if (s.consoleErrors.length) out.push({ label: `Console errors ${s.consoleErrors.length}`, bad: true });
  if (s.failedRequests.length) out.push({ label: `Failed requests ${s.failedRequests.length}`, bad: true });
  for (const p of s.problems) {
    if (p.kind === 'unreachable') out.push({ label: 'Unreachable', bad: true });
    else if (p.kind === 'timeout') out.push({ label: 'Timed out', bad: true });
    else if (p.kind === 'overlay') out.push({ label: 'Error overlay', bad: true });
  }
  if (!out.length && !s.ok) out.push({ label: s.problems[0]?.message.slice(0, 40) || 'Problem', bad: true });
  return out.length ? out : [{ label: 'OK', bad: false }];
}

export interface PageShots { page: string; shots: Shot[] }
/** Shots grouped by page (order of first appearance), phone before laptop. */
export function groupByPage(shots: Shot[]): PageShots[] {
  const m = new Map<string, Shot[]>();
  for (const s of shots) m.set(s.page, [...(m.get(s.page) ?? []), s]);
  return [...m].map(([page, list]) => ({ page, shots: list.sort((a, b) => a.width - b.width) }));
}
/** Flat browsing order of the dialog: page by page, phone then laptop. */
export const browseOrder = (shots: Shot[]): Shot[] => groupByPage(shots).flatMap((g) => g.shots);
/** The same page at the same width in the previous attempt, when it was kept. */
export function previousShot(all: AttemptShots[], s: Shot): Shot | null {
  const prev = all.find((a) => a.attempt === s.attempt - 1);
  return prev?.shots.find((p) => p.page === s.page && p.width === s.width) ?? null;
}
export const widthLabel = (w: number) => (w <= 480 ? `${w} px phone` : `${w} px laptop`);
export const shotUrl = (taskId: number, shotId: number, variant: 'small' | 'full') => `/api/tasks/${taskId}/shots/${shotId}/image?variant=${variant}`;
