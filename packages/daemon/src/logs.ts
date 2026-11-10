/**
 * Task logs, one list of lines per source: setup, tool versions, the dev server, each success check (one per attempt) and
 * the sidecar services. Lines have a numeric id that orders them and doubles as a paging cursor.
 */
import type { Store } from './db.js';
import type { Sandbox } from './sandbox.js';
import type { Task, TaskEvent } from '@bivouac/shared';

export interface LogLine { id: number; /** `HH:MM:SS.mmm` (dev server) or an ISO date */ ts: string | null; text: string }
export interface LogSource { key: string; label: string; kind: 'setup' | 'runtime' | 'dev' | 'check' | 'service' }
export interface LogPage { lines: LogLine[]; /** older lines exist before the first one returned */ hasMore: boolean; /** cursor to follow from */ cursor: number }

const DEV_LOG = '.bivouac/dev.log';
const STAMP = /^(\d{2}:\d{2}:\d{2}\.\d{3}) /;
const EVENT_STRIDE = 100_000; // lines per event in the id space

/** Lines of a dev.log window; ids are byte offsets of the start of each line. */
export function parseDevLines(text: string, startOffset: number): LogLine[] {
  const pieces = text.split('\n');
  if (text.endsWith('\n') || text === '') pieces.pop(); // nothing follows the last newline
  let off = startOffset;
  return pieces.map((raw) => {
    const m = STAMP.exec(raw);
    const line = { id: off, ts: m ? m[1] : null, text: m ? raw.slice(m[0].length) : raw };
    off += Buffer.byteLength(raw) + 1;
    return line;
  });
}

const isOutput = (e: TaskEvent) => e.kind === 'system' && e.data?.subtype === 'output';
const eventKey = (e: TaskEvent) => (e.data.label === 'check' ? `check:${e.iteration}` : String(e.data.label));
function eventLines(e: TaskEvent): LogLine[] {
  const lines = String(e.data.text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((text, i) => ({ id: e.id * EVENT_STRIDE + i, ts: e.createdAt, text }));
}

/** Docker's `--timestamps` output: `2026-11-09T22:00:00.123456789Z message`. */
export function parseServiceLines(text: string): LogLine[] {
  const out: LogLine[] = [];
  let n = 0;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/.exec(raw);
    out.push({ id: (m ? Date.parse(m[1]) : Date.now()) * 1000 + (n++ % 1000), ts: m ? m[1] : null, text: m ? m[2] : raw });
  }
  return out;
}

export class TaskLogs {
  constructor(private store: Store, private sandboxFor: (t: Task) => Sandbox) {}

  sources(t: Task): LogSource[] {
    const out: LogSource[] = [];
    const seen = new Set<string>();
    for (const e of this.store.listEvents(t.id, 0, 100000)) {
      if (!isOutput(e)) continue;
      const k = eventKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
    }
    if (seen.has('setup')) out.push({ key: 'setup', label: 'Setup', kind: 'setup' });
    if (seen.has('runtime')) out.push({ key: 'runtime', label: 'Tool versions', kind: 'runtime' });
    out.push({ key: 'dev', label: 'Dev server', kind: 'dev' });
    for (const k of [...seen].filter((x) => x.startsWith('check:')).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))) out.push({ key: k, label: `Check, attempt ${k.slice(6)}`, kind: 'check' });
    for (const s of t.services) out.push({ key: `svc:${s.name}`, label: s.name, kind: 'service' });
    return out;
  }

  private eventSourceLines(t: Task, key: string): LogLine[] {
    return this.store.listEvents(t.id, 0, 100000).filter((e) => isOutput(e) && eventKey(e) === key).flatMap(eventLines);
  }

  /** A page of lines ending just before `before` (default: the end). */
  async page(t: Task, key: string, o: { before?: number; limit?: number } = {}): Promise<LogPage> {
    const limit = Math.min(Math.max(o.limit ?? 500, 1), 5000);
    if (key === 'dev') {
      const sb = this.sandboxFor(t);
      let before = o.before, lines: LogLine[] = [], start = 0, size = 0;
      // read windows upwards until enough lines (long lines make a window hold few)
      for (let i = 0; i < 8; i++) {
        const w = await sb.tail(DEV_LOG, { before, bytes: 65536 });
        size = w.size; start = w.start;
        lines = [...parseDevLines(w.text, w.start), ...lines];
        if (lines.length >= limit || w.start === 0 || w.text === '') break;
        before = w.start;
      }
      if (lines.length > limit) { lines = lines.slice(-limit); start = lines[0].id; }
      return { lines, hasMore: start > 0 && lines.length > 0, cursor: size };
    }
    if (key.startsWith('svc:')) {
      const all = parseServiceLines(await this.sandboxFor(t).serviceLogs(key.slice(4), limit * 4 + (o.before ? 5000 : 0)).catch(() => ''));
      const older = o.before ? all.filter((l) => l.id < o.before!) : all;
      const lines = older.slice(-limit);
      return { lines, hasMore: older.length > lines.length || all.length >= limit * 4, cursor: all.length ? all[all.length - 1].id : 0 };
    }
    const all = this.eventSourceLines(t, key);
    const older = o.before ? all.filter((l) => l.id < o.before!) : all;
    const lines = older.slice(-limit);
    return { lines, hasMore: older.length > lines.length, cursor: all.length ? all[all.length - 1].id : 0 };
  }

  /** What was appended after `cursor` (a line id for events/services, a byte offset for the dev server). */
  async since(t: Task, key: string, cursor: number): Promise<{ lines: LogLine[]; cursor: number }> {
    if (key === 'dev') {
      const w = await this.sandboxFor(t).tail(DEV_LOG, { after: cursor, bytes: 262144 });
      if (w.size < cursor) return { lines: [], cursor: w.size }; // the file was truncated
      return { lines: parseDevLines(w.text, w.start), cursor: w.end };
    }
    const lines = key.startsWith('svc:') ? parseServiceLines(await this.sandboxFor(t).serviceLogs(key.slice(4), 300).catch(() => '')).filter((l) => l.id > cursor) : this.eventSourceLines(t, key).filter((l) => l.id > cursor);
    return { lines, cursor: lines.length ? lines[lines.length - 1].id : cursor };
  }
}
