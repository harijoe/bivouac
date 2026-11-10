import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, GitBranch, GitPullRequest, Info, Send, Square } from 'lucide-react';
import { isTerminal } from '@bivouac/shared';
import { ago, api, ApiError, duration, fmtTok, fmtUsd, totalTokens, type Share, type TaskEvent, type TaskView } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { LogViewer } from '@/components/app/log-viewer';
import { EmptyState, ErrorNote, Note, PageSkeleton, STATUS, StatusBadge } from '@/components/app/misc';
import { TaskHistory } from '@/components/app/task-history';
import { ResumeButton, TaskLimits } from '@/components/app/task-limits';
import { TaskManage } from '@/components/app/task-manage';
import { TaskShares } from '@/components/app/task-shares';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAsync, useNow, useStream } from '@/lib/hooks';
import { Link } from '@/lib/router';
import { isClaudeProblem } from '@/lib/task-items';

const TABS = ['activity', 'logs', 'sharing', 'settings'] as const;
type Tab = (typeof TABS)[number];
// `#attempt-12` is a link to an attempt of the Activity tab
const tabFromHash = (): Tab => (TABS as readonly string[]).includes(location.hash.slice(1)) ? (location.hash.slice(1) as Tab) : 'activity';


function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

export function TaskPage({ project, name }: { project: string; name: string }) {
  const [task, setTask] = useState<TaskView | null>(null);
  const [missing, setMissing] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [msg, setMsg] = useState('');
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  // live events are handed to the history, which loads its own pages: nothing is replayed from the start
  const listeners = useRef(new Set<(e: TaskEvent) => void>());
  const subscribe = useCallback((fn: (e: TaskEvent) => void) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);
  const readies = useRef(0);
  const [reconnects, setReconnects] = useState(0);
  const act = useAsync();
  const send = useAsync();
  const id = task?.id;

  const setTab = (t: string) => { setTabState(t as Tab); history.replaceState(null, '', `${location.pathname}${location.search}#${t}`); };
  useEffect(() => { const f = () => setTabState(tabFromHash()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);

  const reload = useCallback(async () => {
    try {
      const t = await api<TaskView>('GET', `/api/projects/${project}/tasks/${name}`);
      const full = await api<TaskView>('GET', `/api/tasks/${t.id}`);
      setTask(full); setShares(full.shares ?? []);
    } catch (e) { if (e instanceof ApiError && e.status === 404) setMissing(true); }
  }, [project, name]);
  useEffect(() => { setTask(null); setMissing(false); readies.current = 0; void reload(); }, [reload]);
  useStream(id ? `/api/stream?task=${id}&tail=1` : '/api/stream', {
    task: (t) => { if (t.id === id) setTask((old) => (old ? { ...old, ...t } : old)); },
    event: (e: TaskEvent) => { listeners.current.forEach((fn) => fn(e)); },
    ready: () => { readies.current += 1; if (readies.current > 1) setReconnects((n) => n + 1); },
  });
  const active = !!task && !isTerminal(task.status);
  const now = useNow(active);

  if (missing) return <EmptyState title="This task does not exist (anymore)" action={<Button asChild><Link to={`/projects/${project}`}>Back to the project</Link></Button>}>It may have been renamed or deleted.</EmptyState>;
  if (!task) return <PageSkeleton rows={3} />;

  const openPreview = (port?: string) => act.run(async () => {
    const w = window.open('', '_blank'); // opened now so the browser does not block it after the request
    try { const r = await api('POST', `/api/tasks/${task.id}/preview-link`, port ? { port } : {}); if (w) w.location.href = r.url; else location.href = r.url; } catch (e) { w?.close(); throw e; }
  });
  const post = (p: string) => act.run(async () => { await api('POST', `/api/tasks/${task.id}/${p}`, {}); await reload(); });
  const waiting = task.status === 'blocked' || task.status === 'stuck';
  const hint = STATUS[task.status].hint;
  const isCost = task.costKind === 'cost';
  const canResume = !active && task.status !== 'succeeded';
  const afterResume = async () => { await reload(); };

  const submitMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const text = msg.trim();
    if (!text) return;
    // the box is emptied only once the daemon accepted the message
    void send.run(async () => { await api('POST', `/api/tasks/${task.id}/instruct`, { text }); setMsg(''); await reload(); });
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-3"><h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">{task.name}</h1><StatusBadge status={task.status} /></div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <Link to={`/projects/${task.projectName}`} className="underline underline-offset-4 hover:text-foreground">{task.projectName}</Link>
            <span aria-hidden="true">·</span><span>attempt {Math.max(1, task.iteration)} of {task.maxIterations}</span>
            {task.startedAt && <><span aria-hidden="true">·</span><span>{duration(task.startedAt, task.finishedAt, now)}</span></>}
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              {fmtUsd(task.usage.costUsd)} {isCost ? 'cost' : 'estimated API equivalent'} of {fmtUsd(task.maxCostUsd)} limit
              {!isCost && (
                <Tooltip>
                  <TooltipTrigger asChild><button type="button" aria-label="What is the estimated API equivalent?" className="inline-flex size-6 items-center justify-center rounded-full hover:text-foreground"><Info className="size-3.5" /></button></TooltipTrigger>
                  <TooltipContent className="max-w-64">Not money spent: with a Claude subscription this is what the same usage would cost on the API. The limit is a safeguard on consumption.</TooltipContent>
                </Tooltip>
              )}
            </span>
            {task.accountName && <><span aria-hidden="true">·</span><span>Claude account: {task.accountName}</span></>}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {task.devPort && <AsyncButton className="h-11 sm:h-9" busyLabel="Opening…" onClick={() => openPreview()}><ExternalLink />Open preview</AsyncButton>}
        {task.ports.filter((p) => !p.primary).map((p) => <AsyncButton key={p.name} variant="outline" className="h-11 sm:h-9" busyLabel="Opening…" onClick={() => openPreview(p.name)}><ExternalLink />Open {p.name}</AsyncButton>)}
        {active
          ? <AsyncButton variant="outline" className="h-11 sm:h-9" busyLabel="Stopping…" onClick={() => post('stop')}><Square />Stop</AsyncButton>
          : canResume && <ResumeButton task={task} variant={waiting ? 'default' : 'outline'} onDone={afterResume} />}
        <AsyncButton variant="outline" className="h-11 sm:h-9" busyLabel="Pushing the branch…" onClick={() => post('push')}><GitBranch />{task.pushed ? 'Push again' : 'Push branch'}</AsyncButton>
        {task.prUrl
          ? <Button asChild variant="outline" className="h-11 sm:h-9"><a href={task.prUrl} target="_blank" rel="noreferrer"><GitPullRequest />View pull request</a></Button>
          : <AsyncButton variant="outline" className="h-11 sm:h-9" busyLabel="Opening the pull request…" onClick={() => post('pr')}><GitPullRequest />Open pull request</AsyncButton>}
      </div>
      <ErrorNote>{act.error}</ErrorNote>

      {waiting && task.error ? (
        <Note tone="warn" title={task.status === 'blocked' ? 'The agent is waiting for you' : 'The agent was stopped because it was stuck'}>
          <pre className="my-2 max-h-60 overflow-auto rounded-md bg-background/60 p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground">{task.error}</pre>
          {task.status === 'blocked' ? 'Answer in the message box below, then press Resume.' : 'The same check failed twice with no change to the code. Give it a new direction in the message box below, then press Resume.'} Nothing is retried automatically.
        </Note>
      ) : (
        <>
          {hint && !task.error && <Note>{hint}</Note>}
          {task.error && (
            <Note tone="error" title={isClaudeProblem(task.error) ? 'Your Claude connection has a problem' : undefined}>
              {task.error}{' '}
              {isClaudeProblem(task.error) && <Link to="/settings/claude" className="font-medium underline underline-offset-4">Reconnect</Link>}
              {hint && <span className="mt-1 block">{hint}</span>}
            </Note>
          )}
        </>
      )}
      {task.configError && <Note tone="warn">The <code className="font-mono">bivouac.yml</code> in this branch has a problem, so the previous settings are still used: {task.configError}</Note>}

      <form className="space-y-2 rounded-lg border p-4" onSubmit={submitMessage}>
        <Label htmlFor="instruction">Send a message to the agent</Label>
        <Textarea id="instruction" rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={active ? 'Tell the agent something…' : 'Tell the agent something (the task resumes)…'}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); }} />
        <ErrorNote>{send.error}</ErrorNote>
        <div className="flex flex-wrap items-center gap-3">
          <AsyncButton type="submit" className="h-11 sm:h-9" disabled={!msg.trim()} busy={send.busy} busyLabel="Sending…"><Send />Send</AsyncButton>
          {(task.pendingInstructions ?? 0) > 0 && <span className="text-sm text-muted-foreground">{task.pendingInstructions} message(s) waiting for the next attempt.</span>}
        </div>
      </form>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto sm:w-fit">
          <TabsTrigger value="activity" className="h-10 sm:h-8">Activity</TabsTrigger>
          <TabsTrigger value="logs" className="h-10 sm:h-8">Logs</TabsTrigger>
          <TabsTrigger value="sharing" className="h-10 sm:h-8">Preview &amp; sharing{shares.some((s) => s.active) && ` (${shares.filter((s) => s.active).length})`}</TabsTrigger>
          <TabsTrigger value="settings" className="h-10 sm:h-8">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="pt-3"><TaskHistory task={task} subscribe={subscribe} reconnects={reconnects} /></TabsContent>
        <TabsContent value="logs" className="pt-3"><LogViewer taskId={task.id} live={active} status={task.status} /></TabsContent>
        <TabsContent value="sharing" className="space-y-4 pt-3"><TaskShares task={task} shares={shares} reload={reload} /></TabsContent>
        <TabsContent value="settings" className="space-y-8 pt-3">
          <dl className="space-y-2 text-sm">
            <Fact label="Branch"><code className="font-mono">{task.branch}</code></Fact>
            <Fact label="Started from"><code className="font-mono">{task.baseBranch}</code></Fact>
            <Fact label="Success command"><code className="font-mono">{task.successCommand}</code></Fact>
            <Fact label="Tokens">{fmtTok(totalTokens(task.usage))}</Fact>
            <Fact label="Created">{ago(task.createdAt, now)}</Fact>
            <Fact label={task.ports.length > 1 ? 'Addresses' : 'Preview address'}>
              {task.ports.length > 1
                ? task.ports.map((p) => <div key={p.name}><b>{p.name}</b> <span className="text-muted-foreground">(port {p.port})</span><br /><span className="break-all">{p.url}</span></div>)
                : <span className="break-all">{task.previewUrl}</span>}
            </Fact>
            {task.services.length > 0 && <Fact label="Services">{task.services.map((x) => <div key={x.name}><b>{x.name}</b> <span className="text-muted-foreground">{x.image}</span></div>)}</Fact>}
          </dl>
          <TaskLimits task={task} onSaved={(t) => setTask((old) => (old ? { ...old, ...t } : old))} />
          <TaskManage task={task} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
