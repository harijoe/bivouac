import type { Project, Task, TaskEvent, Usage } from '@bivouac/shared';

export type ProjectWithTotals = Project & { totals: Usage & { tasks: number } };
export type TaskDetail = Task & { pendingInstructions?: number; active?: boolean };
export type { Project, Task, TaskEvent, Usage };

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? r.statusText, j);
  return j as T;
}

export const fmtUsd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
export const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const totalTokens = (u: Usage) => u.inputTokens + u.outputTokens + u.cacheCreationTokens;
export function fmtDuration(start: string | null, end: string | null, now = Date.now()) {
  if (!start) return '–';
  const s = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
  return `${s}s`;
}
