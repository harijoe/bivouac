import { hasAnsi, stripAnsi, type AnsiSpan } from './ansi';

export interface LogLine { id: number; ts: string | null; text: string }

export const MAX_LINES = 200_000;

const ERROR_RE = /\berror\b|\bERR!|\bfail(ed|ure)?\b|Traceback|Exception|✗/i;
const WARN_RE = /\bwarn(ing)?\b/i;
/** Highlight class of a line: errors win over warnings. ANSI codes are ignored. */
export function classifyLine(text: string): 'error' | 'warn' | null {
  const t = hasAnsi(text) ? stripAnsi(text) : text;
  if (ERROR_RE.test(t)) return 'error';
  return WARN_RE.test(t) ? 'warn' : null;
}

/**
 * Merges two id-sorted line arrays without duplicates (ids are unique per source; the first occurrence wins). Fast paths
 * for the common cases: appending live lines and prepending an older page.
 */
export function mergeLines(a: LogLine[], b: LogLine[]): LogLine[] {
  if (!b.length) return a;
  if (!a.length) return dedupe(b);
  if (b[0].id > a[a.length - 1].id) return a.concat(dedupe(b));
  if (b[b.length - 1].id < a[0].id) return dedupe(b).concat(a);
  const seen = new Set<number>();
  const out: LogLine[] = [];
  for (const l of [...a, ...b].sort((x, y) => x.id - y.id)) if (!seen.has(l.id)) { seen.add(l.id); out.push(l); }
  return out;
}
function dedupe(l: LogLine[]): LogLine[] {
  for (let i = 1; i < l.length; i++) if (l[i].id <= l[i - 1].id) return uniqueSorted(l);
  return l;
}
function uniqueSorted(l: LogLine[]): LogLine[] {
  const seen = new Set<number>();
  return [...l].sort((x, y) => x.id - y.id).filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** Keeps the newest `max` lines. */
export const trimOldest = (l: LogLine[], max = MAX_LINES) => (l.length > max ? l.slice(l.length - max) : l);

/** Time shown in front of a line: `HH:MM:SS.mmm` as is, an ISO date as local `HH:MM:SS`, otherwise empty. */
export function fmtTs(ts: string | null): string {
  if (!ts) return '';
  if (/^\d{2}:\d{2}:\d{2}/.test(ts)) return ts;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour12: false });
}

/** The text of lines as saved or copied (without colours). */
export const linesToText = (lines: LogLine[], withTs: boolean) =>
  lines.map((l) => (withTs && fmtTs(l.ts) ? `${fmtTs(l.ts)} ${stripAnsi(l.text)}` : stripAnsi(l.text))).join('\n');

// ---------- search
/** Ranges `[start, end)` of every (non-overlapping, case-insensitive) occurrence of `query` in `plain`. */
export function matchRanges(plain: string, query: string): [number, number][] {
  if (!query) return [];
  const out: [number, number][] = [];
  const h = plain.toLowerCase(), q = query.toLowerCase();
  for (let i = h.indexOf(q); i !== -1; i = h.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}
/** Indexes of the lines containing `query`. */
export function findMatches(lines: LogLine[], query: string): number[] {
  if (!query) return [];
  const q = query.toLowerCase(), out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    if ((hasAnsi(t) ? stripAnsi(t) : t).toLowerCase().includes(q)) out.push(i);
  }
  return out;
}
export type HlSpan = AnsiSpan & { hl?: boolean };
/** Splits styled spans at the boundaries of `ranges` (offsets in the concatenated span text) and flags the matched parts. */
export function applyHighlight(spans: AnsiSpan[], ranges: [number, number][]): HlSpan[] {
  if (!ranges.length) return spans;
  const out: HlSpan[] = [];
  let pos = 0, r = 0;
  for (const s of spans) {
    const end = pos + s.text.length;
    let cur = pos;
    while (cur < end) {
      while (r < ranges.length && ranges[r][1] <= cur) r++;
      const rg = ranges[r];
      if (!rg || rg[0] >= end) { out.push({ ...s, text: s.text.slice(cur - pos) }); cur = end; }
      else if (rg[0] > cur) { out.push({ ...s, text: s.text.slice(cur - pos, rg[0] - pos) }); cur = rg[0]; }
      else { const to = Math.min(rg[1], end); out.push({ ...s, text: s.text.slice(cur - pos, to - pos), hl: true }); cur = to; }
    }
    pos = end;
  }
  return out;
}
