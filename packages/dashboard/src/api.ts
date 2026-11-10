import type { Project, Task, TaskEvent, Usage } from '@bivouac/shared';

export type ProjectWithTotals = Project & {
  totals: Usage & { tasks: number };
  /** Name of the Claude account the project uses (never the token). */
  claudeAccountName: string | null;
  stats: { running: number; failed: number; withPr: number; lastActivityAt: string | null };
};
export type CostKind = 'estimated_api_equivalent' | 'cost';
export type TaskView = Task & { costKind?: CostKind; dashboardUrl: string; pendingInstructions?: number; active?: boolean; shares?: Share[] };
export interface Share { id: number; createdAt: number; expiresAt: number | null; revoked: boolean; active: boolean; url: string | null; urls?: { name: string; url: string }[] }
export interface Session {
  user: { githubId: number; login: string; name: string | null; avatarUrl: string | null; role: 'admin' | 'user' } | null;
  version: string; domain: string; baseUrl: string; githubReady: boolean; setupOpen: boolean; mcpUrl: string;
  /** A chat client (Claude, ChatGPT…) has connected at least once. */
  mcpConnected: boolean;
}
export type { ClaudeAccount } from '@bivouac/shared';
export type { Project, Task, TaskEvent, Usage };

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: { code?: string; [k: string]: unknown }) { super(message); }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? r.statusText, j);
  return j as T;
}

export const fmtUsd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 1)}`;
/** With a Claude subscription the figure is the CLI's API-equivalent estimate, not money spent. */
export const costLabel = (k?: CostKind) => (k === 'cost' ? 'cost' : 'API-equivalent estimate');
export const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const totalTokens = (u: Usage) => u.inputTokens + u.outputTokens + u.cacheCreationTokens;
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function duration(start: string | null, end: string | null, now = Date.now()) {
  if (!start) return '';
  const s = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min`;
  return `${s} s`;
}

export interface UpdateStatus {
  current: string; checkedAt: string | null; error: string | null; auto: boolean; runningTasks: number; canUpdate: boolean;
  available: { version: string; name: string; notes: string; url: string; publishedAt: string | null } | null;
  scheduled: { version: string; by: string; at: string } | null;
  progress: { state: 'running' | 'done' | 'failed' | 'rolled_back'; step: string; steps: string[]; from: string; to: string; error: string | null; startedAt: string; finishedAt: string | null } | null;
}
