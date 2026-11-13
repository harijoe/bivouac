/** Pure helpers for the project alias and environment snapshot sections. */

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];
/** Human readable size, decimal units: 412 MB, 1.3 GB. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let v = n; let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i++; }
  const s = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${UNITS[i]}`;
}

export const shortFingerprint = (f: string) => f.slice(0, 12);

export const MAX_PUBLIC_PATHS = 10;
const ALIAS_RE = /^[a-z0-9-]{1,30}$/;

/** Error message for an alias name, or '' when valid (empty is valid: it removes the alias). */
export function aliasError(v: string): string {
  if (!v) return '';
  if (v.length > 30) return 'At most 30 characters.';
  if (!ALIAS_RE.test(v)) return 'Use lowercase letters, digits and dashes only.';
  if (v.startsWith('-') || v.endsWith('-')) return 'Cannot start or end with a dash.';
  return '';
}

export const aliasHost = (alias: string, domain: string) => `${alias}.${domain}`;
export function aliasUrl(alias: string, domain: string, baseUrl = 'https://x') {
  const proto = baseUrl.startsWith('http://') ? 'http' : 'https';
  return `${proto}://${aliasHost(alias, domain)}`;
}

/** One path per line -> trimmed, blank lines and duplicates dropped. */
export function parsePaths(text: string): string[] {
  return [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];
}

/** Error message for a list of public paths, or ''. */
export function pathsError(paths: string[]): string {
  if (paths.length > MAX_PUBLIC_PATHS) return `At most ${MAX_PUBLIC_PATHS} paths (you have ${paths.length}).`;
  for (const p of paths) {
    if (!p.startsWith('/')) return `“${p}” must start with /.`;
    if (/\s/.test(p) || p.includes('?') || p.includes('#')) return `“${p}” must not contain spaces, ? or #.`;
    if (p.includes('..')) return `“${p}” must not contain “..”.`;
  }
  return '';
}

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,62}$/;

/** Error message for a secret name, or '' when valid or still empty. */
export function secretNameError(v: string): string {
  if (!v) return '';
  if (v.length > 63) return 'At most 63 characters.';
  if (!SECRET_NAME_RE.test(v)) return 'Use capital letters, digits and underscores, starting with a letter, for example LINEAR_API_KEY.';
  return '';
}
