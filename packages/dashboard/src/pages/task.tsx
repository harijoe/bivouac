import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTerminal } from '@bivouac/shared';
import { ago, api, ApiError, duration, fmtTok, fmtUsd, totalTokens, type Share, type TaskEvent, type TaskView } from '../api';
import { Button, CopyField, Details, ErrorNote, Link, navigate, Spinner, StatusPill, statusHint, useAsync, useNow, useStream } from '../ui';

const summarize = (i: any) => String(i?.command ?? i?.file_path ?? i?.pattern ?? i?.path ?? (i ? JSON.stringify(i) : '')).slice(0, 90);

type Item =
  | { kind: 'say'; id: number; text: string; thinking?: boolean }
  | { kind: 'you'; id: number; text: string; queued?: boolean }
  | { kind: 'tools'; id: number; calls: { name: string; input: any; result?: string; bad?: boolean }[] }
  | { kind: 'check'; id: number; ok: boolean; command: string; output: string; exitCode: number }
  | { kind: 'note'; id: number; text: string; bad?: boolean; href?: string };

/** Turns the raw event stream into a short, readable feed: what was said, what was checked, and tool calls folded away. */
function toItems(events: TaskEvent[]): Item[] {
  const out: Item[] = [];
  const pending = new Map<string, { name: string; input: any; result?: string; bad?: boolean }>();
  const lastTools = () => { const l = out[out.length - 1]; return l?.kind === 'tools' ? l : null; };
  for (const e of events) {
    const d = e.data;
    switch (e.kind) {
      case 'assistant_text': if (String(d.text ?? '').trim()) out.push({ kind: 'say', id: e.id, text: d.text, thinking: d.thinking }); break;
      case 'tool_use': {
        const call = { name: d.name, input: d.input };
        pending.set(d.id ?? String(e.id), call);
        const g = lastTools();
        if (g) g.calls.push(call); else out.push({ kind: 'tools', id: e.id, calls: [call] });
        break;
      }
      case 'tool_result': { const c = pending.get(d.toolUseId ?? d.id); if (c) { c.result = String(d.text ?? ''); c.bad = !!d.isError; } break; }
      case 'user_instruction': out.push({ kind: 'you', id: e.id, text: d.text, queued: d.queued }); break;
      case 'check': out.push({ kind: 'check', id: e.id, ok: d.exitCode === 0, command: d.command, output: String(d.output ?? ''), exitCode: d.exitCode }); break;
      case 'error': out.push({ kind: 'note', id: e.id, text: d.message, bad: true }); break;
      case 'system':
        if (d.subtype === 'push') out.push({ kind: 'note', id: e.id, text: `Branch ${d.branch} pushed to GitHub.` });
        else if (d.subtype === 'pr') out.push({ kind: 'note', id: e.id, text: 'Pull request opened.', href: d.url });
        else if (d.subtype === 'config_warning') out.push({ kind: 'note', id: e.id, text: d.message, bad: true });
        break;
      default: break;
    }
  }
  return out;
}

function Feed({ items }: { items: Item[] }) {
  if (!items.length) return <p className="muted">Nothing yet. The agent’s messages will appear here.</p>;
  return (
    <ol className="feed">
      {items.map((it) => {
        switch (it.kind) {
          case 'say': return <li key={it.id} className={`say ${it.thinking ? 'dim' : ''}`}>{it.text}</li>;
          case 'you': return <li key={it.id} className="you"><b>You</b> {it.text}{it.queued && <span className="muted"> · will be applied at the next attempt</span>}</li>;
          case 'tools': return (
            <li key={it.id} className="tools">
              <details><summary>{it.calls.length === 1 ? `Used ${it.calls[0].name}` : `Used ${it.calls.length} tools`}</summary>
                {it.calls.map((c, i) => (
                  <details key={i} className={`call ${c.bad ? 'bad' : ''}`}><summary><b>{c.name}</b> <span className="muted clip">{summarize(c.input)}</span></summary>
                    <pre>{JSON.stringify(c.input, null, 2)}</pre>{c.result && <pre>{c.result}</pre>}</details>
                ))}
              </details>
            </li>
          );
          case 'check': return (
            <li key={it.id} className={`check ${it.ok ? 'ok' : 'bad'}`}>
              <details open={!it.ok}><summary>{it.ok ? 'Check passed' : `Check failed (code ${it.exitCode})`} <code className="clip">{it.command}</code></summary>{it.output.trim() && <pre>{it.output}</pre>}</details>
            </li>
          );
          case 'note': return <li key={it.id} className={`note-line ${it.bad ? 'bad' : ''}`}>{it.text} {it.href && <a href={it.href} target="_blank" rel="noreferrer">Open</a>}</li>;
        }
      })}
    </ol>
  );
}

const DURATIONS = [['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['never', 'No expiry']] as const;

function Shares({ task, shares, reload }: { task: TaskView; shares: Share[]; reload: () => void }) {
  const [dur, setDur] = useState<string>('24h');
  const a = useAsync();
  const active = shares.filter((s) => s.active);
  return (
    <div className="stack">
      <p className="muted">Anyone with a link can view this preview, and only this preview, until it expires or you stop it.</p>
      <div className="copy-row">
        <select value={dur} onChange={(e) => setDur(e.target.value)} aria-label="Link duration">{DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <Button variant="primary" busy={a.busy} onClick={() => a.run(async () => { await api('POST', `/api/tasks/${task.id}/shares`, { duration: dur }); reload(); })}>Create a link</Button>
      </div>
      <ErrorNote>{a.error}</ErrorNote>
      {active.length === 0 && <p className="muted">No active links.</p>}
      {active.map((s) => (
        <div key={s.id} className="share">
          {(s.urls?.length ?? 0) > 1
            ? s.urls!.map((u) => <CopyField key={u.name} value={u.url} label={`${u.name}${s.expiresAt ? ` · expires ${new Date(s.expiresAt * 1000).toLocaleString()}` : ' · no expiry'}`} />)
            : <CopyField value={s.url ?? ''} label={s.expiresAt ? `Expires ${new Date(s.expiresAt * 1000).toLocaleString()}` : 'No expiry'} />}
          <Button variant="ghost" onClick={() => a.run(async () => { await api('DELETE', `/api/tasks/${task.id}/shares/${s.id}`); reload(); })}>Revoke</Button>
        </div>
      ))}
    </div>
  );
}

export function TaskPage({ project, name }: { project: string; name: string }) {
  const [task, setTask] = useState<TaskView | null>(null);
  const [missing, setMissing] = useState(false);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [devLog, setDevLog] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [newName, setNewName] = useState('');
  const seen = useRef(new Set<number>());
  const act = useAsync();
  const id = task?.id;

  const reload = useCallback(async () => {
    try {
      const t = await api<TaskView>('GET', `/api/projects/${project}/tasks/${name}`);
      const full = await api<TaskView>('GET', `/api/tasks/${t.id}`);
      setTask(full); setShares(full.shares ?? []);
    } catch (e) { if (e instanceof ApiError && e.status === 404) setMissing(true); }
  }, [project, name]);
  useEffect(() => { setTask(null); setMissing(false); setEvents([]); seen.current = new Set(); void reload(); }, [reload]);
  useStream(id ? `/api/stream?task=${id}` : '/api/stream', {
    task: (t) => { if (t.id === id) setTask((old) => (old ? { ...old, ...t } : old)); },
    event: (e: TaskEvent) => { if (seen.current.has(e.id)) return; seen.current.add(e.id); setEvents((old) => [...old, e].sort((a, b) => a.id - b.id)); },
  });
  const active = !!task && !isTerminal(task.status);
  const now = useNow(active);
  const items = useMemo(() => toItems(events), [events]);
  const feedEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active) feedEnd.current?.scrollIntoView({ block: 'end' }); }, [items.length, active]);

  if (missing) return <div className="empty"><p className="empty-title">This task does not exist (anymore)</p><p className="muted">It may have been renamed or deleted.</p><Link to="/" className="btn primary">Back to tasks</Link></div>;
  if (!task) return <Spinner />;

  const openPreview = (port?: string) => act.run(async () => {
    const w = window.open('', '_blank');
    try { const r = await api('POST', `/api/tasks/${task.id}/preview-link`, port ? { port } : {}); if (w) w.location.href = r.url; else location.href = r.url; } catch (e) { w?.close(); throw e; }
  });
  const post = (p: string, body?: unknown) => act.run(async () => { await api('POST', `/api/tasks/${task.id}/${p}`, body ?? {}); await reload(); });
  const lastCheck = [...events].reverse().find((e) => e.kind === 'check');
  const hint = statusHint(task.status);
  const claudeProblem = task.error && /claude|token|credential|authenticat/i.test(task.error);

  return (
    <>
      <p className="crumb"><Link to="/">← All tasks</Link></p>
      <header className="task-head">
        <div><h1>{task.name}</h1><p className="muted">{task.projectName} · attempt {Math.max(1, task.iteration)} of {task.maxIterations} · {fmtUsd(task.usage.costUsd)} of {fmtUsd(task.maxCostUsd)}{task.startedAt ? ` · ${duration(task.startedAt, task.finishedAt, now)}` : ''}</p></div>
        <StatusPill s={task.status} />
      </header>

      <div className="actions">
        {task.devPort && <Button variant="primary" onClick={() => openPreview()} busy={act.busy}>Open preview ↗</Button>}
        {task.ports.filter((p) => !p.primary).map((p) => <Button key={p.name} onClick={() => openPreview(p.name)} busy={act.busy}>Open {p.name} ↗</Button>)}
        {active ? <Button variant="danger" onClick={() => post('stop')}>Stop</Button> : task.status !== 'succeeded' && <Button onClick={() => post('resume')}>Resume</Button>}
      </div>
      <ErrorNote>{act.error}</ErrorNote>
      {hint && !task.error && <p className="note">{hint}</p>}
      {task.error && (
        <p className="note error" role="alert">
          {claudeProblem ? <>Your Claude connection has a problem: {task.error} <Link to="/settings#claude">Reconnect Claude</Link></> : task.error}
        </p>
      )}
      {task.configError && <p className="note warn" role="alert">The <code>bivouac.yml</code> in this branch has a problem, so the previous settings are still used: {task.configError}</p>}
      {task.prUrl && <p className="note ok"><a href={task.prUrl} target="_blank" rel="noreferrer">View the pull request ↗</a></p>}

      <section className="card">
        <h2>Progress</h2>
        <Feed items={items} />
        <div ref={feedEnd} />
        <form className="copy-row" onSubmit={(e) => { e.preventDefault(); const text = msg.trim(); if (!text) return; setMsg(''); void act.run(async () => { await api('POST', `/api/tasks/${task.id}/instruct`, { text }); await reload(); }); }}>
          <input placeholder={active ? 'Tell the agent something…' : 'Tell the agent something (it will resume)…'} value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Instruction" />
          <Button disabled={!msg.trim()}>Send</Button>
        </form>
        {(task.pendingInstructions ?? 0) > 0 && <p className="muted">{task.pendingInstructions} message(s) waiting for the next attempt.</p>}
      </section>

      <Details title="Share the preview" badge={shares.some((s) => s.active) ? <span className="count">{shares.filter((s) => s.active).length}</span> : null}>
        <Shares task={task} shares={shares} reload={reload} />
      </Details>
      {lastCheck && <Details title="Last check" open={lastCheck.data.exitCode !== 0} badge={<span className={`count ${lastCheck.data.exitCode === 0 ? 'ok' : 'bad'}`}>{lastCheck.data.exitCode === 0 ? 'passed' : 'failed'}</span>}><p className="muted"><code>{lastCheck.data.command}</code></p><pre>{lastCheck.data.output}</pre></Details>}
      <Details title="Details">
        <dl className="facts">
          <dt>Branch</dt><dd><code>{task.branch}</code></dd>
          <dt>Started from</dt><dd><code>{task.baseBranch}</code></dd>
          <dt>Success command</dt><dd><code>{task.successCommand}</code></dd>
          <dt>Tokens</dt><dd>{fmtTok(totalTokens(task.usage))}</dd>
          <dt>Created</dt><dd>{ago(task.createdAt, now)}</dd>
          <dt>{task.ports.length > 1 ? 'Addresses' : 'Preview address'}</dt>
          <dd className="clip">{task.ports.length > 1 ? task.ports.map((p) => <div key={p.name}><b>{p.name}</b> <span className="muted">(port {p.port})</span><br />{p.url}</div>) : task.previewUrl}</dd>
          {task.services.length > 0 && <><dt>Services</dt><dd>{task.services.map((x) => <div key={x.name}><b>{x.name}</b> <span className="muted">{x.image}</span></div>)}</dd></>}
        </dl>
        <div className="actions">
          <Button onClick={() => post('push')}>{task.pushed ? 'Push again' : 'Push branch to GitHub'}</Button>
          <Button onClick={() => act.run(async () => { await api('POST', `/api/tasks/${task.id}/pr`); await reload(); })}>Open a pull request</Button>
        </div>
      </Details>
      <Details title="Dev server logs">
        <Button variant="secondary" onClick={() => act.run(async () => setDevLog((await api('GET', `/api/tasks/${task.id}/devlogs?lines=300`)).text || 'No output yet.'))}>{devLog === null ? 'Show logs' : 'Refresh'}</Button>
        {devLog !== null && <pre>{devLog}</pre>}
      </Details>
      <Details title="Manage">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { const t = await api<TaskView>('POST', `/api/tasks/${task.id}/rename`, { name: newName }); navigate(`/projects/${t.projectName}/${t.name}`, true); }); }}>
          <label>Rename<input value={newName} placeholder={task.name} onChange={(e) => setNewName(e.target.value.toLowerCase())} pattern="[a-z0-9]([a-z0-9\-]{0,38}[a-z0-9])?" /></label>
          <p className="muted">The preview address changes immediately and existing share links stop working. The git branch keeps its name.</p>
          <Button disabled={!newName || newName === task.name}>Rename</Button>
        </form>
        {(
          <Button variant="danger" onClick={() => act.run(async () => {
            try { await api('DELETE', `/api/tasks/${task.id}`); } catch (x) {
              if (x instanceof ApiError && x.body.code === 'UNPUSHED') { if (!confirm(`${x.message}. Delete anyway and lose this work?`)) return; await api('DELETE', `/api/tasks/${task.id}?force=1`); } else throw x;
            }
            navigate('/');
          })}>Delete this task</Button>
        )}
      </Details>
    </>
  );
}
