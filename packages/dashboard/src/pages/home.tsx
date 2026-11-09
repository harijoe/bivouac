import { useCallback, useEffect, useState } from 'react';
import { isTerminal } from '@bivouac/shared';
import { ago, api, fmtUsd, type ProjectWithTotals, type Session, type TaskView } from '../api';
import { Empty, Link, StatusPill, Spinner, useNow, useStream } from '../ui';

interface Props { session: Session }

export function TaskCard({ t, now }: { t: TaskView; now: number }) {
  const open = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const w = window.open('', '_blank');
    try { const r = await api('POST', `/api/tasks/${t.id}/preview-link`); if (w) w.location.href = r.url; } catch { w?.close(); }
  };
  return (
    <Link to={`/projects/${t.projectName}/${t.name}`} className="task-card">
      <div className="task-top"><span className="task-name">{t.name}</span><StatusPill s={t.status} /></div>
      <p className="task-title">{t.title}</p>
      <div className="task-meta">
        <span title={t.costKind === 'cost' ? 'Cost' : 'Estimated API-equivalent value, not a spend (Claude subscription)'}>{fmtUsd(t.usage.costUsd)}{t.costKind === 'cost' ? '' : ' est.'}</span>
        <span>{isTerminal(t.status) ? ago(t.finishedAt, now) : `attempt ${Math.max(1, t.iteration)} of ${t.maxIterations}`}</span>
        {t.devPort && t.status !== 'queued' && <button className="link-btn" onClick={open}>Open preview ↗</button>}
      </div>
    </Link>
  );
}

export function Home({ session }: Props) {
  const [projects, setProjects] = useState<ProjectWithTotals[] | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [claude, setClaude] = useState<{ connected: boolean; expired: boolean } | null>(null);
  const load = useCallback(() => {
    void api('GET', '/api/projects').then(setProjects);
    void api('GET', '/api/tasks').then(setTasks);
    void api('GET', '/api/claude').then(setClaude);
  }, []);
  useEffect(load, [load]);
  useStream('/api/stream', { task: load, project: load });
  const now = useNow(true);
  if (!projects) return <Spinner />;

  const working = tasks.filter((t) => !isTerminal(t.status)).length;
  const done = tasks.filter((t) => t.status === 'succeeded').length;
  const spent = projects.reduce((s, p) => s + p.totals.costUsd, 0);
  const admin = session.user?.role === 'admin';

  // one next step at a time, in the order a new user needs them
  let next: { title: string; text: string; to: string; cta: string } | null = null;
  if (claude && (!claude.connected || claude.expired)) next = { title: claude.expired ? 'Your Claude token expired' : 'Connect Claude', text: claude.expired ? 'Reconnect it so tasks can run again.' : 'Agents need your Claude account to work.', to: '/settings#claude', cta: claude.expired ? 'Reconnect' : 'Connect Claude' };
  else if (projects.length === 0 && admin) next = { title: 'Add a project', text: 'Pick a GitHub repository for the agents to work on.', to: '/settings#projects', cta: 'Add a project' };

  return (
    <>
      {next && (
        <section className="callout">
          <div><b>{next.title}</b><p>{next.text}</p></div>
          <Link to={next.to} className="btn primary">{next.cta}</Link>
        </section>
      )}
      {tasks.length > 0 && (
        <p className="summary">
          <span><b>{working}</b> working</span><span><b>{done}</b> done</span><span><b>{fmtUsd(spent)}</b> {tasks[0]?.costKind === 'cost' ? 'spent' : 'estimated API equivalent'}</span>
        </p>
      )}
      {projects.length === 0 && !next && <Empty title="No project yet"><p className="muted">Ask an administrator to add a GitHub repository.</p></Empty>}
      {projects.map((p) => {
        const pt = tasks.filter((t) => t.projectId === p.id);
        return (
          <section key={p.id} className="project">
            <header className="project-head"><h2>{p.name}</h2><span className="muted">{p.totals.tasks} {p.totals.tasks === 1 ? 'task' : 'tasks'} · {fmtUsd(p.totals.costUsd)}</span></header>
            {pt.length === 0
              ? <Empty title="No tasks yet"><p className="muted">Ask Claude to create one.</p><Link to="/connect" className="btn secondary">Connect your chat</Link></Empty>
              : <div className="task-list">{pt.map((t) => <TaskCard key={t.id} t={t} now={now} />)}</div>}
          </section>
        );
      })}
    </>
  );
}
