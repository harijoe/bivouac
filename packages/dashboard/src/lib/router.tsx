import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

/** History API routing; the server falls back to index.html for every non-API path. */
export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}
export function useLocation() {
  const [loc, setLoc] = useState(location.pathname + location.search + location.hash);
  useEffect(() => {
    const f = () => setLoc(location.pathname + location.search + location.hash);
    addEventListener('popstate', f);
    return () => removeEventListener('popstate', f);
  }, []);
  return loc;
}
/** Splits `/a/b?x=1#h` into its parts. */
export function parseLocation(loc: string) {
  const [pathAndQuery, hash = ''] = loc.split('#');
  const [path, query = ''] = pathAndQuery.split('?');
  return { path, query: new URLSearchParams(query), hash };
}
export function Link({ to, children, className, ...p }: { to: string; children: ReactNode; className?: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return <a {...p} href={to} className={className} onClick={(e) => { p.onClick?.(e); if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(to); }}>{children}</a>;
}
/** `/projects/:project/:task` -> { project, task }; null when it does not match. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean), b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) out[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}
