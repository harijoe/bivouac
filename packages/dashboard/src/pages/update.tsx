import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ago, type UpdateStatus } from '../api';
import { Button, ErrorNote, Link, Spinner, useAsync } from '../ui';

/** Fetches the update state; polls faster while an update is running (the server goes away and comes back). */
export function useUpdate(enabled: boolean) {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const load = useCallback(async () => {
    try { setSt(await api<UpdateStatus>('GET', '/api/update')); setOffline(false); } catch (e) { if ((e as { status?: number }).status === undefined || (e as { status?: number }).status! >= 500) setOffline(true); }
  }, []);
  const running = st?.progress?.state === 'running';
  useEffect(() => { if (!enabled) return; void load(); const t = setInterval(load, running || offline ? 2000 : 60_000); return () => clearInterval(t); }, [enabled, load, running, offline]);
  return { st, offline, reload: load };
}

/** Tiny, safe Markdown renderer for release notes: headings, lists, code, links, bold. No HTML is ever injected. */
export function Notes({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, i) => {
    let m;
    if ((m = /^\*\*([^*]+)\*\*$/.exec(part))) return <b key={i}>{m[1]}</b>;
    if ((m = /^`([^`]+)`$/.exec(part))) return <code key={i}>{m[1]}</code>;
    if ((m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part))) return <a key={i} href={m[2]} target="_blank" rel="noreferrer noopener">{m[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push(<ul key={out.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; } };
  let code: string[] | null = null;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('```')) { if (code) { out.push(<pre key={out.length}>{code.join('\n')}</pre>); code = null; } else { flush(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { list.push(li[1]); continue; }
    flush();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) out.push(<h4 key={out.length}>{inline(h[2])}</h4>);
    else if (line.trim()) out.push(<p key={out.length}>{inline(line)}</p>);
  }
  flush();
  if (code) out.push(<pre key={out.length}>{code.join('\n')}</pre>);
  return <div className="notes">{out}</div>;
}

/** Discreet banner, administrators only. */
export function UpdateBanner({ enabled }: { enabled: boolean }) {
  const { st } = useUpdate(enabled);
  if (!st) return null;
  if (st.progress?.state === 'running') return <Link to="/update" className="update-banner">Updating to {st.progress.to}… <b>See progress</b></Link>;
  if (st.scheduled) return <Link to="/update" className="update-banner">Update to {st.scheduled.version} starts when the running tasks finish</Link>;
  if (!st.available) return null;
  return <Link to="/update" className="update-banner">Version {st.available.version} is available <b>What’s new</b></Link>;
}

const STEP_LABELS: Record<string, string> = {
  backup: 'Back up your data', pull: 'Download the new version', configure: 'Prepare the configuration', restart: 'Restart bivouac', health: 'Check that everything works',
};

function Progress({ st, offline }: { st: UpdateStatus; offline: boolean }) {
  const p = st.progress!;
  const idx = p.steps.indexOf(p.step);
  return (
    <section className="card">
      <h2>{p.state === 'running' ? `Updating to ${p.to}…` : p.state === 'done' ? `Updated to ${p.to}` : p.state === 'rolled_back' ? 'The update did not work. Nothing was lost.' : 'The update failed'}</h2>
      <ol className="steps">
        {p.steps.map((s, i) => {
          const state = p.state === 'done' ? 'done' : i < idx ? 'done' : i === idx ? (p.state === 'running' ? 'now' : 'bad') : 'todo';
          return <li key={s} className={`step ${state}`}>{STEP_LABELS[s] ?? s}</li>;
        })}
      </ol>
      {p.state === 'running' && <p className="muted">{offline ? 'bivouac is restarting. This page reconnects by itself.' : 'This takes about a minute. You can leave this page open.'}</p>}
      {p.state === 'rolled_back' && <p className="note warn">{p.error} <br />bivouac is back on version {p.from}.</p>}
      {p.state === 'failed' && <p className="note error">{p.error}</p>}
      {p.state === 'done' && <p className="note ok">Your projects, tasks and settings are unchanged. Reloading…</p>}
    </section>
  );
}

export function UpdatePage({ loadedVersion }: { loadedVersion: string }) {
  const { st, offline, reload } = useUpdate(true);
  const a = useAsync();
  const [mode, setMode] = useState<'idle' | 'now'>('idle');
  const [confirming, setConfirming] = useState(false);
  const startedHere = useRef(false);

  // once the new version answers, load its dashboard
  useEffect(() => { if (st && st.current !== loadedVersion) location.reload(); }, [st, loadedVersion]);
  useEffect(() => { if (st?.progress?.state === 'done' && startedHere.current) { const t = setTimeout(() => location.reload(), 1500); return () => clearTimeout(t); } }, [st]);

  if (!st) return <Spinner />;
  const av = st.available;
  const showProgress = st.progress && (st.progress.state === 'running' || (startedHere.current && st.progress.to === av?.version) || (st.progress.state !== 'done' && st.progress.to === av?.version && Date.now() - Date.parse(st.progress.startedAt) < 3600_000));
  const act = (fn: () => Promise<unknown>) => a.run(async () => { await fn(); await reload(); });

  return (
    <>
      <p className="crumb"><Link to="/settings#version">← Settings</Link></p>
      <h1>Update bivouac</h1>
      <p className="muted">Installed version: <b>{st.current}</b></p>
      {showProgress && st.progress && <Progress st={st} offline={offline} />}
      {!showProgress && !av && (
        <section className="card">
          <p className="status-line ok"><i className="dot" />bivouac is up to date.</p>
          <p className="muted">{st.checkedAt ? `Last checked ${ago(st.checkedAt)}.` : 'Not checked yet.'}</p>
          <ErrorNote>{st.error}</ErrorNote>
          <Button busy={a.busy} onClick={() => act(() => api('POST', '/api/update/check'))}>Check now</Button>
        </section>
      )}
      {!showProgress && av && (
        <>
          <section className="card">
            <h2>Version {av.version} is available</h2>
            {av.publishedAt && <p className="muted">Published {ago(av.publishedAt)}.{av.url && <> <a href={av.url} target="_blank" rel="noreferrer">View on GitHub ↗</a></>}</p>}
            {av.notes ? <Notes text={av.notes} /> : <p className="muted">No release notes.</p>}
          </section>
          {st.scheduled ? (
            <section className="card">
              <p className="note">Waiting for {st.runningTasks} running task{st.runningTasks === 1 ? '' : 's'} to finish. The update starts by itself, and no new task starts until then.</p>
              <Button busy={a.busy} onClick={() => act(() => api('DELETE', '/api/update/schedule'))}>Cancel the update</Button>
            </section>
          ) : !st.canUpdate ? (
            <p className="note">Updates from the dashboard are not available on this installation. Run the installer again over SSH to update.</p>
          ) : !confirming ? (
            <div className="actions"><Button variant="primary" onClick={() => setConfirming(true)}>Update to {av.version}</Button></div>
          ) : (
            <section className="card">
              <h2>Before you update</h2>
              <ul>
                <li>Your database and settings are backed up first (the last 3 backups are kept).</li>
                <li>bivouac is unavailable for about a minute while it restarts.</li>
                <li>If the new version does not start, bivouac goes back to {st.current} by itself and tells you why.</li>
              </ul>
              {st.runningTasks > 0 ? (
                <div className="stack">
                  <label className="choice"><input type="radio" checked={mode === 'idle'} onChange={() => setMode('idle')} /> <span><b>Update when no task is running</b> (recommended)<br /><span className="muted">{st.runningTasks} task{st.runningTasks === 1 ? ' is' : 's are'} running. No new task starts until the update is done.</span></span></label>
                  <label className="choice"><input type="radio" checked={mode === 'now'} onChange={() => setMode('now')} /> <span><b>Update now</b><br /><span className="muted">The running tasks are stopped. You can resume them afterwards.</span></span></label>
                </div>
              ) : <p className="muted">No task is running.</p>}
              <ErrorNote>{a.error}</ErrorNote>
              <div className="actions">
                <Button variant={mode === 'now' && st.runningTasks > 0 ? 'danger' : 'primary'} busy={a.busy} onClick={() => act(async () => { startedHere.current = true; await api('POST', '/api/update/start', { mode: st.runningTasks > 0 ? mode : 'idle' }); })}>
                  {st.runningTasks > 0 ? (mode === 'now' ? 'Stop the tasks and update now' : 'Update when tasks are done') : 'Update now'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

/** Version and automatic updates, in the settings. */
export function VersionSection({ version }: { version: string }) {
  const { st, reload } = useUpdate(true);
  const a = useAsync();
  return (
    <section className="card" id="version">
      <h2>Version</h2>
      <p>bivouac <b>{version}</b>{st && !st.available && ' · up to date'}</p>
      {st?.available && <p className="note">Version {st.available.version} is available. <Link to="/update">See what’s new and update</Link></p>}
      {st && <p className="muted">{st.checkedAt ? `Last checked ${ago(st.checkedAt)}.` : 'Not checked yet.'}</p>}
      <ErrorNote>{st?.error || a.error}</ErrorNote>
      <div className="actions">
        <Button busy={a.busy} onClick={() => a.run(async () => { await api('POST', '/api/update/check'); await reload(); })}>Check now</Button>
      </div>
      {st && (
        <label className="choice">
          <input type="checkbox" checked={st.auto} onChange={(e) => a.run(async () => { await api('PUT', '/api/update/auto', { enabled: e.target.checked }); await reload(); })} />
          <span><b>Update automatically</b><br /><span className="muted">New versions are installed at night, only when no task is running, with the same backup and automatic rollback.</span></span>
        </label>
      )}
    </section>
  );
}
