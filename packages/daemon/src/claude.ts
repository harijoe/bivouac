/** Parsing of `claude setup-token` terminal output (captured from the real CLI, see test/fixtures). */

// eslint-disable-next-line no-control-regex
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/;

export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (hyperlinks, titles)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '') // CSI sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[78=>]/g, '')
    .replace(/\r\n?/g, '\n');
}

/** The sign-in URL printed by the CLI: the full target of the first terminal hyperlink, else the wrapped plain text. */
export function parseLoginUrl(raw: string): string | null {
  const m = OSC8.exec(raw);
  if (m) return m[1];
  const lines = stripAnsi(raw).split('\n');
  const start = lines.findIndex((l) => /https:\/\/\S/.test(l));
  if (start < 0) return null;
  let url = lines[start].slice(lines[start].indexOf('https://')).trim();
  for (let i = start + 1; i < lines.length && /^\S+$/.test(lines[i].trim()) && lines[i].trim().length > 0; i++) url += lines[i].trim();
  return url;
}

/** The long-lived token printed at the end (may be wrapped over several lines by the terminal). */
export function parseToken(raw: string): string | null {
  const lines = stripAnsi(raw).split('\n').map((l) => l.trim());
  const i = lines.findIndex((l) => l.includes('sk-ant-'));
  if (i < 0) return null;
  let tok = lines[i].slice(lines[i].indexOf('sk-ant-')).split(/\s/)[0];
  for (let j = i + 1; j < lines.length && /^[A-Za-z0-9_-]+$/.test(lines[j]); j++) tok += lines[j];
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(tok) ? tok : null;
}

export type LoginPhase = 'starting' | 'waiting_code' | 'done' | 'error';
export interface LoginState { phase: LoginPhase; url?: string; token?: string; message?: string }

export function loginState(raw: string, done: boolean, exitCode: number | null): LoginState {
  const token = parseToken(raw);
  if (token) return { phase: 'done', token };
  const url = parseLoginUrl(raw);
  if (done) {
    const text = stripAnsi(raw).trim().split('\n').slice(-6).join(' ').slice(0, 300);
    return { phase: 'error', url: url ?? undefined, message: `Claude sign-in ended without a token (exit code ${exitCode}). ${text}` };
  }
  if (url && /Paste code here/i.test(stripAnsi(raw))) return { phase: 'waiting_code', url };
  return { phase: 'starting' };
}

export const TOKEN_LIFETIME_DAYS = 365;
