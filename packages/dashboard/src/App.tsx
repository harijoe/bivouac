import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminal, type TaskStatus } from '@bivouac/shared';
import { api, ApiError, fmtDuration, fmtTok, fmtUsd, totalTokens, type ProjectWithTotals, type TaskDetail, type TaskEvent, type Usage } from './api';

// ---------- tiny hash router
function useRoute() {
  const [h, setH] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const f = () => setH(location.hash.slice(1) || '/');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return h;
}

/** Subscribe to the daemon SSE stream; calls onMessage for every event type. Auto-reconnects. */
function useStream(url: string, handlers: Record<string, (data: any, lastId: string) => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const es = new EventSource(url);
    for (const name of ['task', 'project', 'event', 'ready']) {
      es.addEventListener(name, (e) => ref.current[name]?.(JSON.parse((e as MessageEvent).data), (e as MessageEvent).lastEventId));
    }
    return () => es.close();
  }, [url]);
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'queued', starting: 'starting', running: 'running', checking: 'checking', succeeded: 'succeeded', failed: 'failed',
  budget_exceeded: 'budget exceeded', max_iterations: 'max iterations', stopped: 'stopped',
};
const Badge = ({ s }: { s: TaskStatus }) => <span className={`badge st-${s}`}>{STATUS_LABEL[s]}</span>;

function UsageLine({ u }: { u: Usage }) {
  return <span className="usage" title={`in ${u.inputTokens} · out ${u.outputTokens} · cache write ${u.cacheCreationTokens} · cache read ${u.cacheReadTokens}`}>{fmtTok(totalTokens(u))} tok · {fmtUsd(u.costUsd)}</span>;
}

function useNow(active: boolean) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  return n;
}

// ---------- login
function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  return (
    <form className="card login" onSubmit={async (e) => { e.preventDefault(); try { await api('POST', '/api/login', { token }); onDone(); } catch (x: any) { setErr(x.message); } }}>
      <h1>⛺ bivouac</h1>
      <p className="muted">Enter the access token printed by the installer (<code>/etc/bivouac/bivouac.env</code>).</p>
      <input type="password" autoFocus placeholder="access token" value={token} onChange={(e) => setToken(e.target.value)} />
      {err && <p className="error">{err}</p>}
      <button className="primary" disabled={!token}>Sign in</button>
    </form>
  );
}

// ---------- home: projects
function Home() {
  const [projects, setProjects] = useState<ProjectWithTotals[]>([]);
  const [totals, setTotals] = useState<(Usage & { tasks: number }) | null>(null);
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => { api('GET', '/api/projects').then(setProjects); api('GET', '/api/totals').then(setTotals); api('GET', '/api/tasks').then(setTasks); }, []);
  useEffect(load, [load]);
  useStream('/api/stream', { task: () => load(), project: () => load() });
  const running = tasks.filter((t) => !isTerminal(t.status)).length;
  return (
    <>
      <div className="stats">
        <div className="stat"><b>{totals?.tasks ?? 0}</b><span>tasks</span></div>
        <div className="stat"><b>{running}</b><span>active</span></div>
        <div className="stat"><b>{fmtTok(totals ? totalTokens(totals) : 0)}</b><span>tokens</span></div>
        <div className="stat"><b>{fmtUsd(totals?.costUsd ?? 0)}</b><span>est. cost</span></div>
      </div>
      <div className="row between"><h2>Projects</h2><button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : '+ Add project'}</button></div>
      {adding && <AddProject onDone={() => { setAdding(false); load(); }} />}
      {projects.length === 0 && !adding && <p className="muted">No project yet. Add a git repository to get started.</p>}
      <div className="grid">
        {projects.map((p) => (
          <a key={p.id} className="card link" href={`#/p/${p.id}`}>
            <b>{p.name}</b>
            <span className="muted ellipsis">{p.repoUrl}</span>
            <span className="muted">{p.totals.tasks} task(s) · <UsageLine u={p.totals} /></span>
          </a>
        ))}
      </div>
    </>
  );
}

function AddProject({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ repoUrl: '', githubToken: '', name: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="card form" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await api('POST', '/api/projects', f); onDone(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } }}>
      <label>Repository URL<input required placeholder="https://github.com/you/your-app.git" value={f.repoUrl} onChange={(e) => setF({ ...f, repoUrl: e.target.value })} /></label>
      <label>GitHub token <span className="muted">(fine-grained, contents + pull requests on this repo)</span><input type="password" placeholder="github_pat_…" value={f.githubToken} onChange={(e) => setF({ ...f, githubToken: e.target.value })} /></label>
      <label>Name <span className="muted">(optional, used in preview URLs)</span><input placeholder="my-app" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      {err && <p className="error">{err}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Checking access…' : 'Add project'}</button>
    </form>
  );
}

// ---------- project page
function ProjectPage({ id }: { id: number }) {
  const [project, setProject] = useState<ProjectWithTotals | null>(null);
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [creating, setCreating] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const load = useCallback(() => { api('GET', '/api/projects').then((ps: ProjectWithTotals[]) => setProject(ps.find((p) => p.id === id) ?? null)); api('GET', `/api/tasks?project=${id}`).then(setTasks); }, [id]);
  useEffect(load, [load]);
  useStream('/api/stream', { task: () => load() });
  const now = useNow(tasks.some((t) => !isTerminal(t.status)));
  if (!project) return <p className="muted">Loading…</p>;
  return (
    <>
      <p><a href="#/">← Projects</a></p>
      <div className="row between wrap"><div><h2>{project.name}</h2><span className="muted ellipsis">{project.repoUrl} · base <code>{project.defaultBranch}</code></span></div>
        <div className="row"><button onClick={() => setShowCfg(!showCfg)}>Config</button><button className="primary" onClick={() => setCreating(!creating)}>{creating ? 'Cancel' : '+ New task'}</button></div></div>
      <p className="muted">Total: <UsageLine u={project.totals} /></p>
      {showCfg && <ConfigEditor project={project} onDone={() => { setShowCfg(false); load(); }} />}
      {creating && <NewTask projectId={id} onDone={(t) => { location.hash = `#/t/${t.id}`; }} />}
      <div className="list">
        {tasks.map((t) => (
          <a key={t.id} className="card link task-row" href={`#/t/${t.id}`}>
            <div className="row between"><b>t-{t.id} · {t.title}</b><Badge s={t.status} /></div>
            <div className="muted row wrap gap">
              <span>iter {t.iteration}/{t.maxIterations}</span><UsageLine u={t.usage} /><span>{fmtDuration(t.startedAt, t.finishedAt, now)}</span>
              {t.previewUrl && <span className="ellipsis" onClick={(e) => { e.preventDefault(); window.open(t.previewUrl!, '_blank'); }} role="link">↗ {t.previewUrl.replace(/^https?:\/\//, '')}</span>}
            </div>
          </a>
        ))}
        {tasks.length === 0 && <p className="muted">No task yet.</p>}
      </div>
    </>
  );
}

function ConfigEditor({ project, onDone }: { project: ProjectWithTotals; onDone: () => void }) {
  const [json, setJson] = useState(JSON.stringify(project.config, null, 2));
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="card form">
      <p className="muted">Dashboard overrides merged on top of <code>bivouac.yml</code> from the repo (keys: image, setup, dev.command, dev.port, success, limits.cpus, limits.memory, budget.*).</p>
      <textarea rows={8} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      <label>Replace GitHub token<input type="password" placeholder={project.hasGithubToken ? '(token set — leave empty to keep)' : 'github_pat_…'} value={token} onChange={(e) => setToken(e.target.value)} /></label>
      {err && <p className="error">{err}</p>}
      <button className="primary" onClick={async () => { try { await api('PATCH', `/api/projects/${project.id}`, { config: JSON.parse(json), ...(token ? { githubToken: token } : {}) }); onDone(); } catch (x: any) { setErr(x.message); } }}>Save</button>
    </div>
  );
}

function NewTask({ projectId, onDone }: { projectId: number; onDone: (t: TaskDetail) => void }) {
  const [f, setF] = useState({ prompt: '', successCommand: '', maxCostUsd: '', maxIterations: '', baseBranch: '', publicPreview: false });
  const [err, setErr] = useState('');
  const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== false));
  return (
    <form className="card form" onSubmit={async (e) => { e.preventDefault(); try { onDone(await api('POST', `/api/projects/${projectId}/tasks`, body)); } catch (x: any) { setErr(x.message); } }}>
      <label>Prompt<textarea required rows={5} placeholder="Add a button that increments a counter, with a test." value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} /></label>
      <label>Success command <span className="muted">(default: from bivouac.yml)</span><input placeholder="pnpm test && pnpm build" value={f.successCommand} onChange={(e) => setF({ ...f, successCommand: e.target.value })} /></label>
      <div className="row gap wrap">
        <label className="grow">Max cost (USD)<input type="number" step="0.5" min="0" placeholder="20" value={f.maxCostUsd} onChange={(e) => setF({ ...f, maxCostUsd: e.target.value })} /></label>
        <label className="grow">Max iterations<input type="number" min="1" placeholder="10" value={f.maxIterations} onChange={(e) => setF({ ...f, maxIterations: e.target.value })} /></label>
        <label className="grow">Base branch<input placeholder="default" value={f.baseBranch} onChange={(e) => setF({ ...f, baseBranch: e.target.value })} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={f.publicPreview} onChange={(e) => setF({ ...f, publicPreview: e.target.checked })} /> Public preview behind basic auth <span className="muted">(only reachable from the internet if your DNS/firewall allows it)</span></label>
      {err && <p className="error">{err}</p>}
      <button className="primary">Start task</button>
    </form>
  );
}

// ---------- task page
function EventView({ e }: { e: TaskEvent }) {
  const d = e.data;
  switch (e.kind) {
    case 'assistant_text': return <div className={`ev text ${d.thinking ? 'thinking' : ''}`}>{d.text}</div>;
    case 'tool_use': return <details className="ev tool"><summary>🔧 {d.name} <span className="muted ellipsis">{summarizeInput(d.input)}</span></summary><pre>{JSON.stringify(d.input, null, 2)}</pre></details>;
    case 'tool_result': return <details className={`ev tool ${d.isError ? 'bad' : ''}`}><summary>↳ result{d.isError ? ' (error)' : ''} <span className="muted ellipsis">{(d.text ?? '').slice(0, 80)}</span></summary><pre>{d.text}</pre></details>;
    case 'user_instruction': return <div className="ev instr">💬 You: {d.text}{d.queued ? <span className="muted"> (queued for next iteration)</span> : null}</div>;
    case 'check': return <details className={`ev check ${d.exitCode === 0 ? 'ok' : 'bad'}`} open={d.exitCode !== 0}><summary>{d.exitCode === 0 ? '✅' : '❌'} check <code>{d.command}</code> → exit {d.exitCode}</summary><pre>{d.output}</pre></details>;
    case 'status': return <div className="ev status">● {String(d.status).replace('_', ' ')}{d.error ? ` — ${d.error}` : ''}</div>;
    case 'result': return <div className="ev status">∑ run finished ({d.subtype}) · {fmtUsd(d.costUsd ?? 0)} · {d.numTurns ?? '?'} turns</div>;
    case 'error': return <div className="ev bad">⚠ {d.message}</div>;
    case 'system':
      if (d.subtype === 'output') return <details className="ev tool"><summary>⌁ {d.label} output</summary><pre>{d.text}</pre></details>;
      if (d.subtype === 'init') return <div className="ev status">session started · {d.model}</div>;
      if (d.subtype === 'setup') return <div className="ev status">⚙ setup: <code>{d.command}</code></div>;
      if (d.subtype === 'clone') return <div className="ev status">⎇ branch <code>{d.branch}</code> from <code>{d.base}</code></div>;
      if (d.subtype === 'push' || d.subtype === 'pr') return <div className="ev status">⬆ {d.subtype === 'pr' ? <a href={d.url} target="_blank" rel="noreferrer">pull request</a> : `pushed ${d.branch}`}</div>;
      if (d.subtype === 'config_warning') return <div className="ev bad">{d.message}</div>;
      return null;
    default: return null;
  }
}
const summarizeInput = (i: any) => (i?.command ?? i?.file_path ?? i?.pattern ?? i?.path ?? (i ? JSON.stringify(i) : '')).toString().slice(0, 100);

function TaskPage({ id }: { id: number }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [tab, setTab] = useState<'events' | 'dev'>('events');
  const [devLog, setDevLog] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<number>());
  useEffect(() => { setEvents([]); seen.current = new Set(); api('GET', `/api/tasks/${id}`).then(setTask).catch(() => setTask(null)); }, [id]);
  useStream(`/api/stream?task=${id}`, {
    task: (t) => { if (t.id === id) setTask((old) => ({ ...old, ...t })); },
    event: (e: TaskEvent) => { if (seen.current.has(e.id)) return; seen.current.add(e.id); setEvents((old) => [...old, e]); },
  });
  useEffect(() => { if (follow) bottom.current?.scrollIntoView({ block: 'end' }); }, [events, follow, tab]);
  useEffect(() => {
    if (tab !== 'dev') return;
    const f = () => api('GET', `/api/tasks/${id}/devlogs?lines=300`).then((r) => setDevLog(r.text));
    f(); const t = setInterval(f, 3000); return () => clearInterval(t);
  }, [tab, id]);
  const active = !!task && !isTerminal(task.status);
  const now = useNow(active);
  const act = async (name: string, fn: () => Promise<any>) => { setErr(''); try { await fn(); const t = await api('GET', `/api/tasks/${id}`); setTask(t); } catch (x) { setErr(`${name}: ${(x as Error).message}`); } };
  if (!task) return <p className="muted">Loading…</p>;
  const lastCheck = [...events].reverse().find((e) => e.kind === 'check');
  const pct = Math.min(100, (task.usage.costUsd / task.maxCostUsd) * 100);
  return (
    <>
      <p><a href={`#/p/${task.projectId}`}>← {task.projectName}</a></p>
      <div className="row between wrap"><h2>t-{task.id} · {task.title}</h2><Badge s={task.status} /></div>
      {task.error && <p className="error">{task.error}</p>}
      <div className="stats">
        <div className="stat"><b>{task.iteration}/{task.maxIterations}</b><span>iteration</span></div>
        <div className="stat"><b>{fmtTok(totalTokens(task.usage))}</b><span>tokens</span></div>
        <div className="stat"><b>{fmtUsd(task.usage.costUsd)}</b><span>of {fmtUsd(task.maxCostUsd)}</span></div>
        <div className="stat"><b>{fmtDuration(task.startedAt, task.finishedAt, now)}</b><span>duration</span></div>
      </div>
      <div className="bar" title={`${pct.toFixed(0)}% of cost budget`}><i style={{ width: `${pct}%` }} /></div>
      <p className="row wrap gap">
        <code>{task.branch}</code>
        {task.previewUrl && <a href={task.previewUrl} target="_blank" rel="noreferrer">↗ open preview</a>}
        {task.prUrl && <a href={task.prUrl} target="_blank" rel="noreferrer">↗ pull request</a>}
      </p>
      <div className="row wrap gap actions">
        {active ? <button className="danger" onClick={() => act('stop', () => api('POST', `/api/tasks/${id}/stop`))}>■ Stop</button>
          : <button onClick={() => act('resume', () => api('POST', `/api/tasks/${id}/resume`, {}))}>▶ Resume</button>}
        <button onClick={() => act('push', () => api('POST', `/api/tasks/${id}/push`))}>{task.pushed ? '⬆ Push again' : '⬆ Push branch'}</button>
        <button onClick={() => act('pr', () => api('POST', `/api/tasks/${id}/pr`))}>Open PR</button>
        <button className="danger" onClick={() => act('delete', async () => {
          try { await api('DELETE', `/api/tasks/${id}`); }
          catch (x) { if (x instanceof ApiError && x.body.code === 'UNPUSHED') { if (!confirm(`${x.message}. Delete anyway and lose these commits?`)) return; await api('DELETE', `/api/tasks/${id}?force=1`); } else throw x; }
          location.hash = `#/p/${task.projectId}`;
        })}>Delete</button>
      </div>
      {err && <p className="error">{err}</p>}
      <form className="row gap instr-form" onSubmit={(e) => { e.preventDefault(); if (!msg.trim()) return; const text = msg; setMsg(''); act('send', () => api('POST', `/api/tasks/${id}/instruct`, { text })); }}>
        <input className="grow" placeholder={active ? 'Send an instruction (applied at the next iteration)…' : 'Send an instruction (resumes the agent)…'} value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button className="primary">Send</button>
      </form>
      {(task.pendingInstructions ?? 0) > 0 && <p className="muted">{task.pendingInstructions} instruction(s) queued.</p>}
      {lastCheck && <details className="card" open={lastCheck.data.exitCode !== 0}><summary>Last check: {lastCheck.data.exitCode === 0 ? '✅ passed' : `❌ exit ${lastCheck.data.exitCode}`} <code>{lastCheck.data.command}</code></summary><pre>{lastCheck.data.output}</pre></details>}
      <div className="tabs"><button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>Agent</button><button className={tab === 'dev' ? 'on' : ''} onClick={() => setTab('dev')}>Dev server logs</button>
        <label className="check follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label></div>
      {tab === 'events' ? <div className="events">{events.map((e) => <EventView key={e.id} e={e} />)}{events.length === 0 && <p className="muted">Waiting for events…</p>}</div>
        : <pre className="devlog">{devLog || 'No dev server output yet.'}</pre>}
      <div ref={bottom} />
    </>
  );
}

// ---------- shell
export function App() {
  const route = useRoute();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [info, setInfo] = useState<any>(null);
  const check = useCallback(() => api('GET', '/api/info').then((i) => { setInfo(i); setAuthed(true); }).catch(() => setAuthed(false)), []);
  useEffect(() => { check(); }, [check]);
  if (authed === null) return null;
  if (!authed) return <div className="wrap-login"><Login onDone={check} /></div>;
  const m = /^\/(p|t)\/(\d+)/.exec(route);
  return (
    <div className="shell">
      <header><a href="#/" className="brand">⛺ bivouac</a><span className="muted">{info?.version}</span>
        {!info?.auth?.oauth && !info?.auth?.apiKey && <AuthBanner onDone={check} />}</header>
      <main>{m?.[1] === 'p' ? <ProjectPage id={Number(m[2])} key={m[2]} /> : m?.[1] === 't' ? <TaskPage id={Number(m[2])} key={m[2]} /> : <Home />}</main>
    </div>
  );
}

function AuthBanner({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState('');
  return (
    <form className="banner" onSubmit={async (e) => { e.preventDefault(); await api('PUT', '/api/settings', v.startsWith('sk-ant-api') ? { anthropicApiKey: v } : { claudeOauthToken: v }); onDone(); }}>
      <span>No Claude credentials configured:</span>
      <input type="password" placeholder="CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="primary" disabled={!v}>Save</button>
    </form>
  );
}
