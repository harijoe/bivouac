import type { AttemptSummary, HistoryMarker, TaskEvent } from '@bivouac/shared';

/** The history of a task as the page holds it: attempt summaries (newest first) and what happened since the newest one began. */
export interface HistoryState {
  attempts: AttemptSummary[];
  /** Markers after the newest attempt: they attach to the next attempt when it starts. */
  trailing: HistoryMarker[];
  hasMore: boolean;
  /** Events received live, by attempt, for attempts whose events were not (or not yet) loaded. */
  live: Record<number, TaskEvent[]>;
}
export const emptyHistory: HistoryState = { attempts: [], trailing: [], hasMore: false, live: {} };

const STATE_STATUSES = new Set(['stopped', 'blocked', 'stuck', 'budget_exceeded', 'max_iterations', 'failed', 'succeeded', 'queued']);

/** Same rule as the daemon (attempts.ts): what happens between attempts is a marker, everything else belongs to an attempt. */
export function markerOf(e: TaskEvent): HistoryMarker | null {
  const d = e.data ?? {};
  if (e.kind === 'user_instruction') return { id: e.id, kind: 'instruction', at: e.createdAt, text: String(d.text ?? ''), queued: !!d.queued };
  if (e.kind === 'status' && STATE_STATUSES.has(d.status) && !(e.iteration === 0 && d.status === 'queued')) return { id: e.id, kind: 'state', at: e.createdAt, status: d.status === 'queued' ? 'resumed' : d.status, error: d.error ?? null };
  if (e.kind === 'system' && d.subtype === 'limits_changed') return { id: e.id, kind: 'limits', at: e.createdAt, text: String(d.message ?? '') };
  return null;
}
/** Events the feed shows (the others only move the header). */
export const isFeedEvent = (e: TaskEvent) => e.kind !== 'status' && e.kind !== 'rate_limit' && !(e.kind === 'system' && (e.data?.subtype === 'output' || e.data?.subtype === 'limits_changed'));

/** A new set of screenshots was taken: the gallery must be fetched again. */
export const isScreenshotsEvent = (e: TaskEvent) => e.kind === 'system' && e.data?.subtype === 'screenshots';

/** Folds one live event into the history. Pure; events already seen (same id) change nothing. */
export function applyEvent(h: HistoryState, e: TaskEvent): HistoryState {
  const m = markerOf(e);
  if (m) {
    if (h.trailing.some((x) => x.id === m.id)) return h;
    return { ...h, trailing: [...h.trailing, m].sort((a, b) => a.id - b.id) };
  }
  if (e.iteration < 1) return h;
  let attempts = h.attempts;
  let trailing = h.trailing;
  let idx = attempts.findIndex((a) => a.attempt === e.iteration);
  if (idx < 0) {
    // a new attempt starts: what happened since the previous one is what triggered it
    if (attempts.length && e.iteration < attempts[0].attempt) return h; // an older attempt we have not loaded: its header is loaded on demand
    const mine = trailing.filter((x) => x.id < e.id);
    trailing = trailing.filter((x) => x.id >= e.id);
    attempts = [{ attempt: e.iteration, startedAt: e.createdAt, endedAt: null, durationMs: 0, running: true, costUsd: null, check: null, lastMessage: null, firstEventId: e.id, lastEventId: e.id, markers: mine }, ...attempts];
    idx = 0;
  }
  const a = attempts[idx];
  if (e.id <= a.lastEventId && e.id !== a.firstEventId && a.lastEventId !== a.firstEventId) {
    if (h.live[e.iteration]?.some((x) => x.id === e.id)) return h;
  }
  const next: AttemptSummary = { ...a, lastEventId: Math.max(a.lastEventId, e.id), durationMs: Math.max(a.durationMs, Date.parse(e.createdAt) - Date.parse(a.startedAt) || 0) };
  const d = e.data ?? {};
  if (e.kind === 'assistant_text' && !d.thinking && String(d.text ?? '').trim()) next.lastMessage = String(d.text).slice(0, 400);
  if (e.kind === 'check') next.check = { passed: d.exitCode === 0, exitCode: d.exitCode, command: String(d.command ?? '') };
  if (e.kind === 'result' && typeof d.costUsd === 'number') next.costUsd = (a.costUsd ?? 0) + d.costUsd;
  const live = { ...h.live };
  if (isFeedEvent(e)) {
    const list = live[e.iteration] ?? [];
    if (!list.some((x) => x.id === e.id)) live[e.iteration] = [...list, e].sort((x, y) => x.id - y.id);
  }
  const out = attempts.slice();
  out[idx] = next;
  return { ...h, attempts: out, trailing, live };
}

/** Loaded events of an attempt merged with the ones received live (by id). */
export function mergeEvents(loaded: TaskEvent[] | undefined, live: TaskEvent[] | undefined): TaskEvent[] {
  const byId = new Map<number, TaskEvent>();
  for (const e of loaded ?? []) byId.set(e.id, e);
  for (const e of live ?? []) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Adds an older page (or replaces the first page on a reload) without duplicating attempts. */
export function mergeAttempts(h: HistoryState, page: { attempts: AttemptSummary[]; hasMore: boolean; trailing?: HistoryMarker[] }, mode: 'replace' | 'append'): HistoryState {
  if (mode === 'replace') return { attempts: page.attempts, trailing: page.trailing ?? [], hasMore: page.hasMore, live: {} };
  const have = new Set(h.attempts.map((a) => a.attempt));
  const attempts = [...h.attempts, ...page.attempts.filter((a) => !have.has(a.attempt))].sort((a, b) => b.attempt - a.attempt);
  return { ...h, attempts, hasMore: page.hasMore };
}

// ---------- presentation
export const STATE_LABEL: Record<string, string> = {
  resumed: 'Resumed', stopped: 'Stopped', blocked: 'Waiting for you', stuck: 'Stopped: stuck', budget_exceeded: 'Budget reached', max_iterations: 'Out of attempts', failed: 'Failed', succeeded: 'Done',
};

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${s} s`;
}

/** Splits text around the occurrences of a query (case-insensitive) so they can be highlighted. */
export function splitMatches(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim();
  if (q.length < 2) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase(), needle = q.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    if (j > i) out.push({ text: text.slice(i, j), match: false });
    out.push({ text: text.slice(j, j + needle.length), match: true });
    i = j + needle.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), match: false });
  return out.length ? out : [{ text, match: false }];
}

/** `#attempt-12` → 12 */
export const attemptFromHash = (hash: string): number | null => { const m = /^#attempt-(\d{1,6})$/.exec(hash); return m ? Number(m[1]) : null; };
