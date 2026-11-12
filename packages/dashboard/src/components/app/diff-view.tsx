import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, FileInput, FileMinus2, FilePen, FilePlus2, GitCommitHorizontal, RefreshCw, type LucideIcon } from 'lucide-react';
import type { AttemptDiff, DiffFile, DiffPatch } from '@bivouac/shared';
import { api, ApiError } from '@/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { classifyPatch, diffHeadline, diffOrigin, fileLabel, LINE_CLASS, nextWindow, type LineKind } from '@/lib/changes';
import { cn } from '@/lib/utils';
import { AsyncButton } from './async-button';
import { ErrorNote, Note } from './misc';

export type Which = number | 'base';
export interface DiffState { data?: AttemptDiff; error?: string; noDiff?: boolean; loading: boolean }

/** Diffs of a task by attempt (or `base`), kept for the life of the page; a refresh keeps the old data on screen until the new one arrives. */
export function useDiffs(taskId: number) {
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  useEffect(() => { setDiffs({}); }, [taskId]);
  const load = useCallback(async (which: Which) => {
    const k = String(which);
    setDiffs((o) => ({ ...o, [k]: { ...o[k], loading: true, error: undefined } }));
    try {
      const data = await api<AttemptDiff>('GET', `/api/tasks/${taskId}/diff/${which}`);
      setDiffs((o) => ({ ...o, [k]: { data, loading: false } }));
    } catch (e) {
      const noDiff = e instanceof ApiError && e.status === 404 && e.body.code === 'no_diff';
      setDiffs((o) => ({ ...o, [k]: { data: noDiff ? undefined : o[k]?.data, loading: false, noDiff, error: noDiff ? undefined : (e as Error).message } }));
    }
  }, [taskId]);
  return { diffs, load };
}

const STATUS_ICON: Record<DiffFile['status'], { icon: LucideIcon; label: string; cls: string }> = {
  added: { icon: FilePlus2, label: 'Added', cls: 'text-emerald-700 dark:text-emerald-300' },
  modified: { icon: FilePen, label: 'Modified', cls: 'text-amber-700 dark:text-amber-300' },
  deleted: { icon: FileMinus2, label: 'Deleted', cls: 'text-red-700 dark:text-red-300' },
  renamed: { icon: FileInput, label: 'Renamed', cls: 'text-sky-700 dark:text-sky-300' },
};

interface PatchState { lines: string[]; kinds: LineKind[]; inHunk: boolean; next: number | null; total: number; binary: boolean; loading: boolean; error: string; started: boolean }
const noPatch: PatchState = { lines: [], kinds: [], inHunk: false, next: null, total: 0, binary: false, loading: false, error: '', started: false };

function FileRow({ taskId, which, file }: { taskId: number; which: Which; file: DiffFile }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<PatchState>(noPatch);
  const { icon: Icon, label, cls } = STATUS_ICON[file.status];

  const fetchWindow = async (offset: number) => {
    setP((o) => ({ ...o, loading: true, error: '', started: true }));
    try {
      const r = await api<DiffPatch>('GET', `/api/tasks/${taskId}/diff/${which}/patch?file=${encodeURIComponent(file.path)}&offset=${offset}&limit=400`);
      setP((o) => {
        const c = classifyPatch(r.lines, offset === 0 ? false : o.inHunk);
        return { lines: offset === 0 ? r.lines : [...o.lines, ...r.lines], kinds: offset === 0 ? c.kinds : [...o.kinds, ...c.kinds], inHunk: c.inHunk, next: r.truncated ? r.nextOffset : null, total: r.total, binary: r.binary, loading: false, error: '', started: true };
      });
    } catch (e) { setP((o) => ({ ...o, loading: false, error: (e as Error).message })); }
  };
  const toggle = (v: boolean) => { setOpen(v); if (v && !p.started && !file.binary) void fetchWindow(0); };
  const { next, hidden } = nextWindow(p.total, p.next);

  return (
    <li className="rounded-md border">
      <Collapsible open={open} onOpenChange={toggle}>
        <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9">
          <ChevronRight className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
          <Icon className={cn('size-4 shrink-0', cls)} aria-hidden="true" /><span className="sr-only">{label}:</span>
          <span className="min-w-0 flex-1 break-all font-mono text-xs">{fileLabel(file)}</span>
          {file.binary
            ? <span className="shrink-0 text-xs text-muted-foreground">binary</span>
            : <span className="shrink-0 font-mono text-xs tabular-nums"><span className="text-emerald-700 dark:text-emerald-300">+{file.added}</span> <span className="text-red-700 dark:text-red-300">−{file.deleted}</span></span>}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 border-t p-2">
            {file.binary || p.binary ? <p className="text-sm text-muted-foreground">Binary file: there is no text patch to show.</p>
              : p.error ? <div className="space-y-2"><ErrorNote>{p.error}</ErrorNote><AsyncButton variant="outline" busyLabel="Loading…" onClick={() => fetchWindow(p.lines.length ? (p.next ?? 0) : 0)}>Try again</AsyncButton></div>
              : !p.lines.length && p.loading ? <div className="space-y-1.5" aria-busy="true" aria-label="Loading the patch"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>
              : !p.lines.length ? <p className="text-sm text-muted-foreground">No textual change in this file (a mode change, for example).</p>
              : (
                <div className="max-h-[32rem] overflow-auto rounded-md border bg-background" tabIndex={0} role="region" aria-label={`Patch of ${file.path}`}>
                  <div className="w-max min-w-full py-1 font-mono text-xs leading-5">
                    {p.lines.map((l, i) => <div key={i} className={cn('whitespace-pre px-2', LINE_CLASS[p.kinds[i]])}>{l || ' '}</div>)}
                  </div>
                </div>
              )}
            {hidden > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <AsyncButton variant="outline" size="sm" className="h-10 sm:h-8" busyLabel="Loading more lines…" onClick={() => fetchWindow(p.next!)}>Show next {next} lines</AsyncButton>
                <span className="text-xs text-muted-foreground">{hidden} lines not shown</span>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** Files changed by an attempt (or by the whole task against its base branch): totals, commits, expandable patches. */
export function DiffPanel({ taskId, which, state, load, noDiffText }: { taskId: number; which: Which; state: DiffState | undefined; load: (w: Which) => Promise<void>; noDiffText?: string }) {
  useEffect(() => { if (!state) void load(which); }, [which, state === undefined]);
  const d = state?.data;
  if (state?.noDiff) return <Note>{noDiffText ?? 'No change record: this attempt ran before bivouac 0.5.'}</Note>;
  if (!state || (!d && state.loading)) return <div className="space-y-2" aria-busy="true" aria-label="Loading the changes"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /></div>;
  if (!d) return <div className="space-y-2"><ErrorNote>{state.error}</ErrorNote><AsyncButton variant="outline" busyLabel="Loading…" onClick={() => load(which)}>Try again</AsyncButton></div>;
  const origin = diffOrigin(d);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{diffHeadline(d.totals)}{origin && <span className="font-normal text-muted-foreground"> · {origin}</span>}</p>
          {d.against && <p className="text-xs text-muted-foreground">Compared with {d.against}</p>}
          {d.live && <p className="text-xs text-sky-600 dark:text-sky-300">Live, still changing: refresh to see the latest.</p>}
        </div>
        <AsyncButton variant="outline" size="sm" className="h-10 sm:h-8" busyLabel="Refreshing…" busy={state.loading} onClick={() => load(which)}><RefreshCw />Refresh</AsyncButton>
      </div>
      <ErrorNote>{state.error}</ErrorNote>
      {d.commits.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex min-h-10 items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />{d.commits.length} {d.commits.length === 1 ? 'commit' : 'commits'}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="space-y-1 pb-1 pl-5 text-sm">
              {d.commits.map((c) => <li key={c.sha} className="flex items-start gap-2"><GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><code className="shrink-0 font-mono text-xs text-muted-foreground">{c.sha.slice(0, 7)}</code><span className="min-w-0 break-words">{c.subject}</span></li>)}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {d.files.length === 0 ? <p className="text-sm text-muted-foreground">No file changed{d.live ? ' yet' : ''}.</p>
        : <ul className="space-y-1.5" aria-label="Changed files">{d.files.map((f) => <FileRow key={`${which}:${f.path}:${d.totals.added}:${d.totals.deleted}`} taskId={taskId} which={which} file={f} />)}</ul>}
    </div>
  );
}

/** The whole task against its base branch (tab "Changes"). */
export function TaskChanges({ taskId }: { taskId: number }) {
  const { diffs, load } = useDiffs(taskId);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Everything this task changed, all attempts together.</p>
      <DiffPanel taskId={taskId} which="base" state={diffs.base} load={load} noDiffText="No change record for this task." />
    </div>
  );
}
