import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { TaskStatus } from '@bivouac/shared';

// ---------- routing (History API; the server falls back to index.html)
export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}
export function useLocation() {
  const [loc, setLoc] = useState(location.pathname + location.search);
  useEffect(() => {
    const f = () => setLoc(location.pathname + location.search);
    addEventListener('popstate', f);
    return () => removeEventListener('popstate', f);
  }, []);
  return loc;
}
export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(to); }}>{children}</a>;
}

// ---------- live updates
export function useStream(url: string, handlers: Record<string, (data: any) => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const es = new EventSource(url);
    for (const name of ['task', 'project', 'event', 'ready']) es.addEventListener(name, (e) => ref.current[name]?.(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  }, [url]);
}
export function useNow(active: boolean) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  return n;
}

// ---------- status: one label and one colour everywhere
export const STATUS: Record<TaskStatus, { label: string; tone: 'working' | 'done' | 'failed' | 'warn' | 'idle' }> = {
  queued: { label: 'Waiting', tone: 'idle' }, starting: { label: 'Starting', tone: 'working' }, running: { label: 'Working', tone: 'working' },
  checking: { label: 'Checking', tone: 'working' }, succeeded: { label: 'Done', tone: 'done' }, failed: { label: 'Failed', tone: 'failed' },
  budget_exceeded: { label: 'Budget reached', tone: 'warn' }, max_iterations: { label: 'Out of attempts', tone: 'warn' }, stopped: { label: 'Stopped', tone: 'idle' },
};
export const StatusPill = ({ s }: { s: TaskStatus }) => <span className={`pill tone-${STATUS[s].tone}`}><i className="dot" />{STATUS[s].label}</span>;
export const statusHint = (s: TaskStatus): string | null => ({
  budget_exceeded: 'The spending limit was reached. Resume to give it a new allowance.',
  max_iterations: 'The agent used all its attempts. Resume to give it more, or send an instruction.',
  failed: 'Something went wrong. Check the message below, then resume.',
  stopped: 'Stopped. Resume to continue where it left off.',
} as Partial<Record<TaskStatus, string>>)[s] ?? null;

// ---------- small building blocks
export function Button({ children, variant = 'secondary', busy, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }) {
  return <button {...p} className={`btn ${variant} ${p.className ?? ''}`} disabled={p.disabled || busy}>{busy ? 'Please wait…' : children}</button>;
}
export function Empty({ title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty"><img className="empty-icon" src="/favicon.svg" alt="" width="36" height="36" /><p className="empty-title">{title}</p>{children}</div>;
}
export function ErrorNote({ children }: { children: ReactNode }) { return children ? <p className="note error" role="alert">{children}</p> : null; }
export function Spinner({ label = 'Loading…' }: { label?: string }) { return <p className="muted center">{label}</p>; }

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy">
      {label && <span className="copy-label">{label}</span>}
      <div className="copy-row">
        <input readOnly value={value} aria-label={label ?? 'value'} onFocus={(e) => e.target.select()} />
        <Button variant="primary" onClick={async () => { try { await navigator.clipboard.writeText(value); } catch { /* clipboard needs https */ } setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? 'Copied' : 'Copy'}</Button>
      </div>
    </div>
  );
}

export function Details({ title, children, open, badge }: { title: string; children: ReactNode; open?: boolean; badge?: ReactNode }) {
  return <details className="fold" open={open}><summary>{title}{badge}</summary><div className="fold-body">{children}</div></details>;
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError('');
    try { return await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}

export function useTheme() {
  const [theme, setTheme] = useState<string>(localStorage.getItem('bv-theme') ?? 'system');
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bv-theme', theme);
  }, [theme]);
  return [theme, setTheme] as const;
}
