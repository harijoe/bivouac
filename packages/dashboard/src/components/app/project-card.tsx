import { ExternalLink, Plus } from 'lucide-react';
import { ago, type ProjectWithTotals } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/lib/router';
import { PullCount, usePulls } from './project-pulls';
import { repoLabel, repoWebUrl } from './project-filters';

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 min-h-5 text-sm font-medium">{children}</dd></div>;
}

/** Project overview card of the home page. */
export function ProjectCard({ p, now }: { p: ProjectWithTotals; now: number }) {
  const { prs, loading } = usePulls(p.id, p.stats.lastActivityAt);
  const repo = repoWebUrl(p);
  const link = `/projects/${encodeURIComponent(p.name)}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="truncate text-lg"><Link to={link} className="underline-offset-4 hover:underline">{p.name}</Link></CardTitle>
        <a href={repo} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <span className="truncate">{repoLabel(p)}</span><ExternalLink className="size-3 shrink-0" aria-hidden="true" />
        </a>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Running">{p.stats.running > 0 ? <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300">{p.stats.running}</Badge> : <span className="text-muted-foreground">0</span>}</Stat>
          <Stat label="Failing">{p.stats.failed > 0 ? <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300">{p.stats.failed}</Badge> : <span className="text-muted-foreground">0</span>}</Stat>
          <Stat label="Open pull requests"><PullCount prs={prs} loading={loading} href={`${repo}/pulls`} /></Stat>
          <Stat label="Last activity">{p.stats.lastActivityAt ? ago(p.stats.lastActivityAt, now) : <span className="text-muted-foreground">none yet</span>}</Stat>
          <Stat label="Claude account"><span className="block truncate">{p.claudeAccountName ?? <span className="text-muted-foreground">default</span>}</span></Stat>
          <Stat label="Tasks">{p.totals.tasks}</Stat>
        </dl>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button asChild className="h-11 sm:h-9"><Link to={`${link}/new`}><Plus />New task</Link></Button>
        <Button asChild variant="outline" className="h-11 sm:h-9"><Link to={link}>Open project</Link></Button>
      </CardFooter>
    </Card>
  );
}
