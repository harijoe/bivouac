/**
 * The history of a task grouped by attempt (one agent run + its success check), newest first, computed by queries so a task with
 * hundreds of attempts is read a page at a time. Events carry the number of the attempt they happened in; the things that happen
 * *between* attempts (an instruction, the task stopping, being resumed, its limits changing) are "markers" and are attached to
 * the attempt that comes after them.
 */
import type Database from 'better-sqlite3';
import type { AttemptSummary, AttemptsPage, HistoryMarker, TaskEvent } from '@bivouac/shared';

const STATE_STATUSES = ['stopped', 'blocked', 'stuck', 'budget_exceeded', 'max_iterations', 'failed', 'succeeded', 'queued'];
/** SQL: the event is a marker. The first `queued` (task creation, attempt 0) is not one. */
const MARKER = `(kind='user_instruction' OR (kind='status' AND json_extract(data_json,'$.status') IN (${STATE_STATUSES.map((s) => `'${s}'`).join(',')}) AND NOT (iteration=0 AND json_extract(data_json,'$.status')='queued')) OR (kind='system' AND json_extract(data_json,'$.subtype')='limits_changed'))`;
const NON_MARKER = `NOT ${MARKER}`;
/** Never shown in the feed: raw command output (it has its own log viewer) and rate-limit pings. */
const FEED_ONLY = `kind NOT IN ('status','rate_limit') AND NOT (kind='system' AND json_extract(data_json,'$.subtype') IN ('output','limits_changed'))`;

export const MAX_ATTEMPT_EVENTS = 4000;

const q = (n: number) => Array.from({ length: n }, () => '?').join(',');

function markerFromRow(r: any): HistoryMarker {
  const d = JSON.parse(r.data_json);
  if (r.kind === 'user_instruction') return { id: r.id, kind: 'instruction', at: r.created_at, text: String(d.text ?? ''), queued: !!d.queued };
  if (r.kind === 'status') return { id: r.id, kind: 'state', at: r.created_at, status: d.status === 'queued' ? 'resumed' : d.status, error: d.error ?? null };
  return { id: r.id, kind: 'limits', at: r.created_at, text: String(d.message ?? '') };
}

export interface AttemptQuery { before?: number; limit?: number; only?: number[] }

export function listAttempts(db: Database.Database, taskId: number, o: AttemptQuery & { activeAttempt?: number | null } = {}): AttemptsPage {
  const limit = Math.min(Math.max(o.limit ?? 20, 1), 500);
  const only = o.only?.length ? [...new Set(o.only)].filter((n) => Number.isInteger(n) && n >= 1).slice(0, 100) : null;
  const base = `FROM events WHERE task_id=? AND iteration>=1 AND ${NON_MARKER}`;
  const rows = (only
    ? db.prepare(`SELECT iteration, MIN(id) first_id, MAX(id) last_id, MIN(created_at) started, MAX(created_at) ended ${base} AND iteration IN (${q(only.length)}) GROUP BY iteration ORDER BY iteration DESC`).all(taskId, ...only)
    : db.prepare(`SELECT iteration, MIN(id) first_id, MAX(id) last_id, MIN(created_at) started, MAX(created_at) ended ${base} ${o.before ? 'AND iteration<?' : ''} GROUP BY iteration ORDER BY iteration DESC LIMIT ?`).all(...[taskId, ...(o.before ? [o.before] : []), limit + 1])) as any[];
  const hasMore = !only && rows.length > limit;
  if (hasMore) rows.pop();
  const lastEventId = ((db.prepare('SELECT MAX(id) m FROM events WHERE task_id=?').get(taskId) as any)?.m as number | null) ?? 0;
  if (!rows.length) return { attempts: [], hasMore: false, lastEventId, trailing: [] };

  const its = rows.map((r) => r.iteration as number);
  const cost = new Map<number, number>();
  for (const r of db.prepare(`SELECT iteration, SUM(json_extract(data_json,'$.costUsd')) c FROM events WHERE task_id=? AND kind='result' AND iteration IN (${q(its.length)}) GROUP BY iteration`).all(taskId, ...its) as any[]) cost.set(r.iteration, r.c ?? 0);
  const check = new Map<number, { passed: boolean; exitCode: number; command: string }>();
  for (const r of db.prepare(`SELECT iteration, json_extract(data_json,'$.exitCode') ec, json_extract(data_json,'$.command') cmd FROM events WHERE task_id=? AND kind='check' AND iteration IN (${q(its.length)}) ORDER BY id`).all(taskId, ...its) as any[]) check.set(r.iteration, { passed: r.ec === 0, exitCode: r.ec, command: String(r.cmd ?? '') });
  const last = new Map<number, string>();
  for (const r of db.prepare(`SELECT iteration, t FROM (SELECT iteration, substr(json_extract(data_json,'$.text'),1,400) t, ROW_NUMBER() OVER (PARTITION BY iteration ORDER BY id DESC) rn FROM events WHERE task_id=? AND kind='assistant_text' AND iteration IN (${q(its.length)}) AND coalesce(json_extract(data_json,'$.thinking'),0)=0 AND trim(coalesce(json_extract(data_json,'$.text'),''))<>'') WHERE rn=1`).all(taskId, ...its) as any[]) last.set(r.iteration, r.t);

  // markers just before each attempt: after the first event of the attempt that precedes it, up to its own first event
  const prevFirst = db.prepare(`SELECT MIN(id) m ${base} AND iteration=(SELECT MAX(iteration) FROM events WHERE task_id=? AND iteration>=1 AND iteration<? AND ${NON_MARKER})`);
  const markersBetween = db.prepare(`SELECT id, kind, created_at, data_json FROM events WHERE task_id=? AND id>? AND id<? AND ${MARKER} ORDER BY id`);
  const attempts: AttemptSummary[] = rows.map((r) => {
    const n = r.iteration as number;
    const lower = ((prevFirst.get(taskId, taskId, n) as any)?.m as number | null) ?? 0;
    const running = o.activeAttempt === n;
    const started = Date.parse(r.started), ended = Date.parse(r.ended);
    return {
      attempt: n, startedAt: r.started, endedAt: running ? null : r.ended, durationMs: Math.max(0, ended - started), running,
      costUsd: cost.has(n) ? cost.get(n)! : null, check: check.get(n) ?? null, lastMessage: last.get(n) ?? null,
      firstEventId: r.first_id, lastEventId: r.last_id,
      markers: (markersBetween.all(taskId, lower, r.first_id) as any[]).map(markerFromRow),
    };
  });

  let trailing: HistoryMarker[] = [];
  if (!only && !o.before) trailing = (markersBetween.all(taskId, rows[0].first_id, Number.MAX_SAFE_INTEGER) as any[]).map(markerFromRow);
  return { attempts, hasMore, lastEventId, trailing };
}

/** Events of one attempt in chronological order, as the feed shows them (no status pings, no raw command output, no markers). */
export function attemptEvents(db: Database.Database, taskId: number, attempt: number): { events: TaskEvent[]; truncated: boolean } {
  const rows = db.prepare(`SELECT * FROM events WHERE task_id=? AND iteration=? AND ${NON_MARKER} AND ${FEED_ONLY} ORDER BY id LIMIT ?`).all(taskId, attempt, MAX_ATTEMPT_EVENTS + 1) as any[];
  const truncated = rows.length > MAX_ATTEMPT_EVENTS;
  if (truncated) rows.pop();
  return { events: rows.map((r) => ({ id: r.id, taskId: r.task_id, iteration: r.iteration, kind: r.kind, data: JSON.parse(r.data_json), createdAt: r.created_at })), truncated };
}

/** The attempt a marker is shown before: the first one that starts after it, otherwise the newest. */
function placeMarker(db: Database.Database, taskId: number, markerId: number): number | null {
  const next = db.prepare(`SELECT iteration FROM (SELECT iteration, MIN(id) f FROM events WHERE task_id=? AND iteration>=1 AND ${NON_MARKER} GROUP BY iteration) WHERE f>? ORDER BY iteration LIMIT 1`).get(taskId, markerId) as any;
  if (next) return next.iteration;
  return ((db.prepare(`SELECT MAX(iteration) m FROM events WHERE task_id=? AND iteration>=1`).get(taskId) as any)?.m as number | null) ?? null;
}

/** Attempts (newest first) whose messages, instructions, checks or tool calls contain the text. */
export function searchAttempts(db: Database.Database, taskId: number, text: string, max = 100): { attempts: number[]; truncated: boolean } {
  const needle = text.trim().toLowerCase().slice(0, 200);
  if (!needle) return { attempts: [], truncated: false };
  const found = new Set<number>();
  const rows = db.prepare(`SELECT DISTINCT iteration FROM events WHERE task_id=? AND iteration>=1 AND kind IN ('assistant_text','tool_use','tool_result','check') AND instr(lower(CASE kind
      WHEN 'assistant_text' THEN coalesce(json_extract(data_json,'$.text'),'')
      WHEN 'tool_result' THEN coalesce(json_extract(data_json,'$.text'),'')
      WHEN 'check' THEN coalesce(json_extract(data_json,'$.command'),'') || ' ' || coalesce(json_extract(data_json,'$.output'),'')
      ELSE data_json END), ?) > 0`).all(taskId, needle) as any[];
  for (const r of rows) found.add(r.iteration);
  for (const r of db.prepare(`SELECT id FROM events WHERE task_id=? AND kind='user_instruction' AND instr(lower(coalesce(json_extract(data_json,'$.text'),'')), ?) > 0 LIMIT 200`).all(taskId, needle) as any[]) {
    const n = placeMarker(db, taskId, r.id);
    if (n) found.add(n);
  }
  const all = [...found].sort((a, b) => b - a);
  return { attempts: all.slice(0, max), truncated: all.length > max };
}
