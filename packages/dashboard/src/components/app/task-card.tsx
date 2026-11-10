import { ExternalLink, GitBranch, GitPullRequest } from 'lucide-react';
import { toast } from 'sonner';
import { isTerminal } from '@bivouac/shared';
import { ago, api, fmtUsd, type TaskView } from '@/api';
import { Card } from '@/components/ui/card';
import { Link } from '@/lib/router';
import { StatusBadge } from './misc';

async function openPreview(t: TaskView) {
  const w = window.open('', '_blank');
  try { const r = await api('POST', `/api/tasks/${t.id}/preview-link`); if (w) w.location.href = r.url; else location.href = r.url; }
  catch (e) { w?.close(); toast.error((e as Error).message); }
}

/** A task as a card; the whole card opens the task (the stretched link), inner links stay clickable above it. */
export function TaskCard({ t, now }: { t: TaskView; now: number }) {
  const cost = t.costKind === 'cost' ? 'cost' : 'est. API equivalent';
  const inner = 'relative z-10 inline-flex min-h-11 items-center gap-1 underline-offset-4 hover:underline sm:min-h-0';
  return (
    <Card className="relative gap-3 p-4 transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-accent/40">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/projects/${encodeURIComponent(t.projectName)}/${encodeURIComponent(t.name)}`} className="min-w-0 truncate font-mono text-sm font-medium outline-none after:absolute after:inset-0 after:content-['']">{t.name}</Link>
        <StatusBadge status={t.status} className="shrink-0" />
      </div>
      <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">{t.title}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{fmtUsd(t.usage.costUsd)} {cost}</span>
        <span>attempt {Math.max(1, t.iteration)}/{t.maxIterations}</span>
        <span className="inline-flex min-w-0 items-center gap-1"><GitBranch className="size-3 shrink-0" aria-hidden="true" /><span className="truncate font-mono">{t.branch}</span></span>
        <span>{isTerminal(t.status) ? ago(t.finishedAt, now) : ago(t.startedAt ?? t.createdAt, now)}</span>
      </div>
      {(t.prUrl || (t.devPort && t.status !== 'queued')) && (
        <div className="flex flex-wrap items-center gap-x-4 text-sm">
          {t.prUrl && <a href={t.prUrl} target="_blank" rel="noreferrer" className={inner}><GitPullRequest className="size-3.5" aria-hidden="true" />Pull request</a>}
          {t.devPort && t.status !== 'queued' && <button type="button" onClick={() => void openPreview(t)} className={inner}><ExternalLink className="size-3.5" aria-hidden="true" />Open preview</button>}
        </div>
      )}
    </Card>
  );
}
