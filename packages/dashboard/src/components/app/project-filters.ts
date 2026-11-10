import type { TaskStatus } from '@bivouac/shared';

export type TaskFilter = 'all' | 'running' | 'attention' | 'done';

export const FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'running', label: 'Running' }, { id: 'attention', label: 'Needs attention' }, { id: 'done', label: 'Done' },
];

const ATTENTION: TaskStatus[] = ['failed', 'blocked', 'stuck', 'budget_exceeded', 'max_iterations'];
const IDLE: TaskStatus[] = ['succeeded', 'stopped', ...ATTENTION];

/** Whether a task with this status belongs to the filter. */
export function matchesFilter(status: TaskStatus, f: TaskFilter): boolean {
  if (f === 'all') return true;
  if (f === 'done') return status === 'succeeded';
  if (f === 'attention') return ATTENTION.includes(status);
  return !IDLE.includes(status);
}

export function countByFilter(tasks: { status: TaskStatus }[]): Record<TaskFilter, number> {
  const out: Record<TaskFilter, number> = { all: tasks.length, running: 0, attention: 0, done: 0 };
  for (const t of tasks) for (const f of ['running', 'attention', 'done'] as const) if (matchesFilter(t.status, f)) out[f]++;
  return out;
}

/** Web address of a project's repository (GitHub `owner/repo` or the clone URL without credentials or `.git`). */
export function repoWebUrl(p: { githubRepo: string | null; repoUrl: string }): string {
  if (p.githubRepo) return `https://github.com/${p.githubRepo}`;
  return p.repoUrl.replace(/^(https?:\/\/)[^@/]*@/, '$1').replace(/\.git$/, '');
}
/** Short label for the repository link. */
export function repoLabel(p: { githubRepo: string | null; repoUrl: string }): string {
  return p.githubRepo ?? repoWebUrl(p).replace(/^https?:\/\//, '');
}
