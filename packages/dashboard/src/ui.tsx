import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { dnsPlan, type TaskStatus } from '@bivouac/shared';

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
  budget_exceeded: { label: 'Budget reached', tone: 'warn' }, max_iterations: { label: 'Out of attempts', tone: 'warn' }, stopped: { label: 'Stopped', tone: 'idle'},
  blocked: { label: 'Needs you', tone: 'warn' }, stuck: { label: 'Stuck', tone: 'warn' },
};
export const StatusPill = ({ s }: { s: TaskStatus }) => <span className={`pill tone-${STATUS[s].tone}`}><i className="dot" />{STATUS[s].label}</span>;
export const statusHint = (s: TaskStatus): string | null => ({
  budget_exceeded: 'The spending limit was reached. Resume to give it a new allowance.',
  max_iterations: 'The agent used all its attempts. Resume to give it more, or send an instruction.',
  failed: 'Something went wrong. Check the message below, then resume.',
  stopped: 'Stopped. Resume to continue where it left off.',
  blocked: 'The agent cannot continue without you. Read what it needs below, answer in a message, then resume.',
  stuck: 'The same check failed twice with no change to the code, so the task was stopped to save tokens. Send an instruction to give it a new direction.',
} as Partial<Record<TaskStatus, string>>)[s] ?? null;

// ---------- small building blocks
/**
 * A button that waits for something shows a spinner and an explicit label (`busyLabel`) and cannot be clicked twice.
 * `busy` is for forms; a click handler that returns a promise gets the same treatment on its own button automatically.
 */
export function Button({ children, variant = 'secondary', busy, busyLabel, onClick, ...p }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean; busyLabel?: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => unknown }) {
  const [own, setOwn] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const waiting = !!busy || own;
  const click = onClick && (async (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = onClick(e);
    if (r instanceof Promise) { setOwn(true); try { await r; } finally { if (alive.current) setOwn(false); } }
  });
  return <button {...p} onClick={click} className={`btn ${variant} ${p.className ?? ''}`} disabled={p.disabled || waiting} aria-busy={waiting || undefined}>{waiting ? <><i className="spin" aria-hidden="true" />{busyLabel ?? 'Please wait…'}</> : children}</button>;
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

/** The two A records to create at the registrar, with names relative to the zone (`@` and `*` for a root domain). */
export function DnsRecords({ domain, ip }: { domain: string; ip: string | null }) {
  const plan = dnsPlan(domain, ip ?? 'this server’s IP');
  return (
    <div className="dns">
      <p className="muted">At your registrar, in the DNS zone of <b>{plan.zone}</b>, create these two records:</p>
      <table><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead><tbody>
        {plan.records.map((r) => <tr key={r.name}><td>{r.type}</td><td><code>{r.name}</code></td><td><code>{r.value}</code></td></tr>)}
      </tbody></table>
      <p className="muted">Some registrars want the full name instead of <code>@</code>: that is <code>{domain}</code>.</p>
    </div>
  );
}
