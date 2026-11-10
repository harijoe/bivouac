/**
 * Minimal ANSI SGR parser for log lines: colours (16 / 256 / truecolor), bold, dim, italic, underline. Every other
 * escape sequence (cursor moves, OSC titles, erase…) is dropped. State is per line (it resets at each call).
 */
export type AnsiColor = number | string; // 0-15 = theme palette index, string = css colour (256 / truecolor)
export interface AnsiSpan { text: string; fg?: AnsiColor; bg?: AnsiColor; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }

// Any escape sequence: CSI (SGR is handled separately), OSC (BEL or ST terminated), two-char escapes.
// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;:]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

export const hasAnsi = (s: string) => s.includes('\x1b');
/** Text without any escape sequence (and without carriage returns). */
export function stripAnsi(s: string): string {
  return (hasAnsi(s) ? s.replace(ESC, '') : s).replace(/\r/g, '');
}

function color256(n: number): AnsiColor | undefined {
  if (!(n >= 0 && n <= 255)) return undefined;
  if (n < 16) return n;
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = n - 16, lv = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${lv(Math.floor(c / 36))},${lv(Math.floor(c / 6) % 6)},${lv(c % 6)})`;
}
const clamp = (n: number) => Math.max(0, Math.min(255, n));

type State = Omit<AnsiSpan, 'text'>;
function applySgr(st: State, raw: string): State {
  const p = raw === '' ? [0] : raw.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
  let s: State = { ...st };
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) s = {};
    else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4) s.underline = true;
    else if (n === 22) { delete s.bold; delete s.dim; }
    else if (n === 23) delete s.italic;
    else if (n === 24) delete s.underline;
    else if (n >= 30 && n <= 37) s.fg = n - 30;
    else if (n === 39) delete s.fg;
    else if (n >= 40 && n <= 47) s.bg = n - 40;
    else if (n === 49) delete s.bg;
    else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
    else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg';
      let c: AnsiColor | undefined;
      if (p[i + 1] === 5) { c = color256(p[i + 2]); i += 2; }
      else if (p[i + 1] === 2) { c = `rgb(${clamp(p[i + 2] ?? 0)},${clamp(p[i + 3] ?? 0)},${clamp(p[i + 4] ?? 0)})`; i += 4; }
      else break; // malformed: ignore the rest
      if (c !== undefined) s[key] = c;
    }
  }
  return s;
}

/** Splits a line into styled spans. Always returns at least one span for non-empty text; adjacent empty spans are dropped. */
export function parseAnsi(input: string): AnsiSpan[] {
  const line = input.replace(/\r/g, '');
  if (!hasAnsi(line)) return line ? [{ text: line }] : [];
  const out: AnsiSpan[] = [];
  let st: State = {}, last = 0;
  const push = (text: string) => { if (text) out.push({ text, ...st }); };
  for (const m of line.matchAll(ESC)) {
    push(line.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) st = applySgr(st, m[1]);
  }
  push(line.slice(last));
  return out;
}

// Full class names must appear literally so Tailwind generates them. Chosen to stay readable on both themes.
const FG = [
  'text-zinc-700 dark:text-zinc-400', 'text-red-700 dark:text-red-400', 'text-green-700 dark:text-green-400', 'text-yellow-700 dark:text-yellow-300',
  'text-blue-700 dark:text-blue-400', 'text-fuchsia-700 dark:text-fuchsia-400', 'text-cyan-700 dark:text-cyan-300', 'text-zinc-500 dark:text-zinc-200',
  'text-zinc-500 dark:text-zinc-400', 'text-red-600 dark:text-red-300', 'text-green-600 dark:text-green-300', 'text-yellow-600 dark:text-yellow-200',
  'text-blue-600 dark:text-blue-300', 'text-fuchsia-600 dark:text-fuchsia-300', 'text-cyan-600 dark:text-cyan-200', 'text-zinc-800 dark:text-white',
];
const BG = [
  'bg-zinc-500/30', 'bg-red-500/30', 'bg-green-500/30', 'bg-yellow-500/30', 'bg-blue-500/30', 'bg-fuchsia-500/30', 'bg-cyan-500/30', 'bg-zinc-400/40',
  'bg-zinc-500/50', 'bg-red-500/50', 'bg-green-500/50', 'bg-yellow-500/50', 'bg-blue-500/50', 'bg-fuchsia-500/50', 'bg-cyan-500/50', 'bg-zinc-300/60',
];

/** Classes and inline colours to render a span with. */
export function spanStyle(s: AnsiSpan): { className: string; style?: { color?: string; backgroundColor?: string } } {
  const cls: string[] = [];
  const style: { color?: string; backgroundColor?: string } = {};
  if (typeof s.fg === 'number') cls.push(FG[s.fg]); else if (s.fg) style.color = s.fg;
  if (typeof s.bg === 'number') cls.push(BG[s.bg]); else if (s.bg) style.backgroundColor = s.bg;
  if (s.bold) cls.push('font-bold');
  if (s.dim) cls.push('opacity-60');
  if (s.italic) cls.push('italic');
  if (s.underline) cls.push('underline');
  return { className: cls.join(' '), style: Object.keys(style).length ? style : undefined };
}
