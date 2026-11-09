/** Parsing of `claude setup-token` terminal output (captured from the real CLI, see test/fixtures). */
import xterm from '@xterm/headless';

// eslint-disable-next-line no-control-regex
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/;

export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (hyperlinks, titles)
    // The CLI's UI positions words with "move to column N" instead of printing spaces: keep them as spaces.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[\d*[GC]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '') // other CSI sequences
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

/**
 * Rebuilds what the user would see on screen from the raw terminal stream. The CLI only rewrites the cells that
 * change and skips the others with cursor moves (`ESC[nC`), so no amount of regex on the raw bytes can recover the text.
 * Wrapped rows are joined back into logical lines.
 */
export async function renderLines(raw: string, cols = 500): Promise<string[]> {
  const term = new xterm.Terminal({ cols, rows: 60, scrollback: 5000, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(raw, resolve));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const l = buf.getLine(i);
      if (!l) continue;
      const t = l.translateToString(true);
      if (l.isWrapped && lines.length) lines[lines.length - 1] += t; else lines.push(t);
    }
    return lines.map((l) => l.trimEnd());
  } finally { term.dispose(); }
}

/** `claude setup-token` prints OAuth tokens of this form; anything else is refused instead of being stored. */
export const OAUTH_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

/** The long-lived token shown on the reconstructed screen. Returns null unless it is well formed. */
export function tokenFromLines(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = /sk-ant-\S+/.exec(lines[i]);
    if (!m) continue;
    // A terminal narrower than the token breaks it over several lines.
    let tok = m[0];
    for (let j = i + 1; j < lines.length && /^[A-Za-z0-9_-]+$/.test(lines[j].trim()); j++) tok += lines[j].trim();
    if (OAUTH_TOKEN.test(tok)) return tok;
  }
  return null;
}
export async function parseToken(raw: string): Promise<string | null> { return tokenFromLines(await renderLines(raw)); }

export type LoginPhase = 'starting' | 'waiting_code' | 'verifying' | 'done' | 'error';
export interface LoginState { phase: LoginPhase; url?: string; token?: string; message?: string }

const OAUTH_ERROR = /OAuth error:/;
/** The CLI's own explanation of a refused code, joined from the lines up to the "Press Enter" hint. */
function oauthErrorMessage(lines: string[]): string | null {
  const i = lines.findIndex((l) => OAUTH_ERROR.test(l));
  if (i < 0) return null;
  const out: string[] = [];
  for (let j = i; j < lines.length && !/Press\s+Enter/i.test(lines[j]) && out.length < 4; j++) if (lines[j].trim()) out.push(lines[j].trim());
  return out.join(' ').replace(/^OAuth error:\s*/, '');
}

/**
 * Where a sign-in session stands. `inputAt` is the offset in `raw` of the last code sent (0 = none yet): the screen is
 * rebuilt from everything, but only what appeared after that point can be an answer to the code (an error already on
 * screen before it belongs to an earlier attempt).
 */
export async function loginState(raw: string, done: boolean, exitCode: number | null, inputAt = 0): Promise<LoginState> {
  const lines = await renderLines(raw);
  const url = parseLoginUrl(raw) ?? undefined;
  const token = tokenFromLines(lines);
  if (token) return { phase: 'done', token };
  const before = inputAt > 0 ? await renderLines(raw.slice(0, inputAt)) : [];
  const err = oauthErrorMessage(lines);
  if (err && err !== oauthErrorMessage(before)) return { phase: 'error', url, message: `Claude did not accept that code: ${err}` };
  if (done) {
    if (lines.some((l) => /sk-ant-/.test(l))) return { phase: 'error', url, message: 'Claude returned a token that looks malformed, so it was not saved. Start over.' };
    const text = lines.filter((l) => l.trim()).slice(-4).join(' ').slice(0, 300);
    return { phase: 'error', url, message: `Claude sign-in ended without a token (exit code ${exitCode}). ${text}` };
  }
  if (inputAt > 0) return { phase: 'verifying', url };
  if (url && lines.some((l) => /Paste\s*code\s*here/i.test(l))) return { phase: 'waiting_code', url };
  return { phase: 'starting' };
}

export const TOKEN_LIFETIME_DAYS = 365;
