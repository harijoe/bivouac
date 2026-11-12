import { useMemo, useState } from 'react';
import { ExternalLink, FolderGit2, ListTodo, Plus } from 'lucide-react';
import { api, type ProjectWithTotals, type Session, type TaskView } from '@/api';
import { AliasSummary } from '@/components/app/project-alias';
import { EmptyState, Note, PageHeader } from '@/components/app/misc';
import { FILTERS, countByFilter, matchesFilter, repoLabel, repoWebUrl, type TaskFilter } from '@/components/app/project-filters';
import { PullList, usePulls } from '@/components/app/project-pulls';
import { TaskCard } from '@/components/app/task-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useLoad, useNow, useStream } from '@/lib/hooks';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="rounded-lg border p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold">{children}</dd></div>;
}

export function ProjectPage({ project, session }: { project: string; session: Session }) {
  const projects = useLoad(() => api<ProjectWithTotals[]>('GET', '/api/projects'));
  const p = projects.data?.find((x) => x.name === project) ?? null;
  const tasks = useLoad(() => (p ? api<TaskView[]>('GET', `/api/tasks?project=${p.id}`) : Promise.resolve(null)), [p?.id]);
  const reload = () => { projects.reload(); tasks.reload(); };
  useStream('/api/stream', { task: reload, project: reload });
  const now = useNow(true);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const { prs, loading: prsLoading } = usePulls(p?.id ?? 0, p?.stats.lastActivityAt);
  const all = tasks.data;
  const counts = useMemo(() => countByFilter(all ?? []), [all]);
  const shown = useMemo(() => (all ?? []).filter((t) => matchesFilter(t.status, filter)), [all, filter]);

  if (projects.error && !projects.data) return <Note tone="error" title="Could not load the project">{projects.error}. Reload the page to try again.</Note>;
  if (!projects.data) return <div className="space-y-4" aria-busy="true"><Skeleton className="h-9 w-1/3" /><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (!p) {
    return (
      <EmptyState icon={FolderGit2} title="Project not found" action={<Button asChild variant="outline" className="mt-2 h-11 sm:h-9"><Link to="/">Back to projects</Link></Button>}>
        There is no project called “{project}”. It may have been renamed or removed.
      </EmptyState>
    );
  }
  const repo = repoWebUrl(p);
  return (
    <div className="space-y-6">
      <PageHeader
        title={p.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a href={repo} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">{repoLabel(p)}<ExternalLink className="size-3" aria-hidden="true" /></a>
            <span>Claude account: {p.claudeAccountName ?? 'default'}</span>
          </span>
        }
        actions={<Button asChild className="h-11 sm:h-9"><Link to={`/projects/${encodeURIComponent(p.name)}/new`}><Plus />New task</Link></Button>}
      />
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Running">{p.stats.running}</Stat>
        <Stat label="Failing">{p.stats.failed}</Stat>
        <Stat label="Open pull requests">{prsLoading ? <Skeleton className="h-6 w-8" /> : prs ? prs.length : '—'}</Stat>
        <Stat label="Tasks">{p.totals.tasks}</Stat>
      </dl>
      <AliasSummary p={p} session={session} taskName={all?.find((t) => t.id === p.aliasTaskId)?.name ?? null} />
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Open pull requests</h2>
        <PullList prs={prs} loading={prsLoading} />
      </section>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Tasks</h2>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter tasks">
            {FILTERS.map((f) => (
              <Button key={f.id} type="button" size="sm" variant={filter === f.id ? 'default' : 'outline'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={cn('h-11 sm:h-8')}>
                {f.label} <span className="opacity-70">{counts[f.id]}</span>
              </Button>
            ))}
          </div>
        </div>
        {tasks.error && !all && <Note tone="error" title="Could not load the tasks">{tasks.error}. Reload the page to try again.</Note>}
        {!all && !tasks.error && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 w-full" />)}</div>}
        {all && all.length === 0 && (
          <EmptyState icon={ListTodo} title="No tasks yet" action={<Button asChild className="mt-2 h-11 sm:h-9"><Link to={`/projects/${encodeURIComponent(p.name)}/new`}><Plus />Create the first task</Link></Button>}>
            Describe what you want changed and an agent will work on it on its own branch.
          </EmptyState>
        )}
        {all && all.length > 0 && shown.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No task matches this filter.</p>}
        {shown.length > 0 && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{shown.map((t) => <TaskCard key={t.id} t={t} now={now} />)}</div>}
      </section>
    </div>
  );
}
