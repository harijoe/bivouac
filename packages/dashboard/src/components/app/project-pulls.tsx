import { GitPullRequest } from 'lucide-react';
import { api } from '@/api';
import { Skeleton } from '@/components/ui/skeleton';
import { useLoad } from '@/lib/hooks';

export interface Pull { number: number; url: string; title: string; branch: string }

/** Open pull requests of a project, loaded on demand; `prs` is null when GitHub could not tell. */
export function usePulls(projectId: number, refreshKey?: unknown) {
  const { data, loading } = useLoad(() => (projectId ? api<{ prs: Pull[] | null }>('GET', `/api/projects/${projectId}/pulls`).then((r) => r.prs).catch(() => null) : Promise.resolve(null)), [projectId, refreshKey]);
  return { prs: data, loading: loading && data === null };
}

/** Count of open PRs (skeleton while loading, "—" when unknown) linking to the PR list. */
export function PullCount({ prs, loading, href }: { prs: Pull[] | null; loading: boolean; href: string }) {
  if (loading) return <Skeleton className="h-5 w-8" />;
  if (!prs) return <span aria-label="Unknown">—</span>;
  return <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">{prs.length}</a>;
}

export function PullList({ prs, loading }: { prs: Pull[] | null; loading: boolean }) {
  if (loading) return <Skeleton className="h-10 w-full" />;
  if (!prs) return <p className="text-sm text-muted-foreground">Open pull requests are unavailable right now (GitHub did not answer).</p>;
  if (!prs.length) return <p className="text-sm text-muted-foreground">No open pull requests.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {prs.map((p) => (
        <li key={p.number}>
          <a href={p.url} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40">
            <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">#{p.number} {p.title}</span>
            <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline sm:max-w-48">{p.branch}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
