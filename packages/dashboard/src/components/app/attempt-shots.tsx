import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck } from 'lucide-react';
import type { AttemptShots, Shot } from '@bivouac/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { browseOrder, groupByPage, previousShot, shotBadges, shotUrl, widthLabel } from '@/lib/changes';
import { cn } from '@/lib/utils';
import { AsyncButton } from './async-button';
import { ErrorNote, Note } from './misc';

export interface ShotsState { data: AttemptShots[] | null; loading: boolean; error: string }

function Badges({ shot }: { shot: Shot }) {
  return (
    <span className="flex flex-wrap gap-1">
      {shotBadges(shot).map((b) => (
        <Badge key={b.label} variant="outline" className={cn('gap-1', b.bad ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}>
          {b.bad ? <CircleAlert className="size-3" aria-hidden="true" /> : <CircleCheck className="size-3" aria-hidden="true" />}{b.label}
        </Badge>
      ))}
    </span>
  );
}

function Thumb({ taskId, shot, onOpen }: { taskId: number; shot: Shot; onOpen: () => void }) {
  const phone = shot.width <= 480;
  return (
    <div className={cn('min-w-0 space-y-1.5', phone && 'max-w-[11rem] sm:max-w-none')}>
      <button type="button" onClick={onOpen} aria-label={`Open the ${widthLabel(shot.width)} screenshot of ${shot.page}`} className="block w-full overflow-hidden rounded-md border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <img src={shotUrl(taskId, shot.id, 'small')} loading="lazy" alt={`${shot.page} at ${widthLabel(shot.width)}, attempt ${shot.attempt}`} width={phone ? 375 : 1280} height={phone ? 500 : 800} className={cn('w-full object-cover object-top', phone ? 'aspect-[3/4]' : 'aspect-[16/10]')} />
      </button>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{shot.width} px</span><Badges shot={shot} /></div>
    </div>
  );
}

/** Screenshots of one attempt: grouped by page, phone and laptop side by side, problems as badges. */
export function AttemptShotsSection({ taskId, attempt, state, ensure, reload }: { taskId: number; attempt: number; state: ShotsState; ensure: () => void; reload: () => Promise<void> }) {
  const [view, setView] = useState<Shot | null>(null);
  useEffect(() => { ensure(); }, []);
  const mine = state.data?.find((a) => a.attempt === attempt);
  const groups = useMemo(() => groupByPage(mine?.shots ?? []), [mine]);

  if (state.error && !state.data) return <div className="space-y-2"><ErrorNote>{state.error}</ErrorNote><AsyncButton variant="outline" busyLabel="Loading…" onClick={reload}>Try again</AsyncButton></div>;
  if (!state.data) return <div className="grid gap-3 sm:grid-cols-[1fr_2fr]" aria-busy="true" aria-label="Loading the screenshots"><Skeleton className="aspect-[3/4] max-w-[11rem] sm:max-w-none" /><Skeleton className="aspect-[16/10]" /></div>;
  if (!mine) return <p className="text-sm text-muted-foreground">No screenshots for this attempt (only the 12 most recent attempts keep theirs).</p>;
  return (
    <div className="space-y-3">
      {mine.checkPassed === false && <Note tone="warn">Success check failed in this attempt.</Note>}
      {mine.error && <Note tone="warn">Could not take screenshots: {mine.error}</Note>}
      {!mine.shots.length && !mine.error && <p className="text-sm text-muted-foreground">No screenshots were taken in this attempt.</p>}
      {groups.map((g) => (
        <div key={g.page} className="space-y-2">
          <p className="break-all font-mono text-xs font-medium">{g.page}</p>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            {g.shots.map((s) => <Thumb key={s.id} taskId={taskId} shot={s} onOpen={() => setView(s)} />)}
          </div>
        </div>
      ))}
      {view && <ShotDialog taskId={taskId} all={state.data} start={view} onClose={() => setView(null)} />}
    </div>
  );
}

function Detail({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{title} ({items.length})</p>
      <ul className="max-h-32 space-y-1 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">{items.map((t, i) => <li key={i} className="break-all">{t}</li>)}</ul>
    </div>
  );
}

function ShotDialog({ taskId, all, start, onClose }: { taskId: number; all: AttemptShots[]; start: Shot; onClose: () => void }) {
  const list = useMemo(() => browseOrder(all.find((a) => a.attempt === start.attempt)?.shots ?? [start]), [all, start]);
  const [idx, setIdx] = useState(Math.max(0, list.findIndex((s) => s.id === start.id)));
  const [compare, setCompare] = useState(false);
  const shot = list[idx] ?? start;
  const pages = [...new Set(list.map((s) => s.page))];
  const widths = [...new Set(list.filter((s) => s.page === shot.page).map((s) => s.width))];
  const prev = compare ? previousShot(all, shot) : null;
  const go = (i: number) => setIdx(Math.min(list.length - 1, Math.max(0, i)));
  const pick = (page: string, width: number) => { const i = list.findIndex((s) => s.page === page && s.width === width); if (i >= 0) setIdx(i); };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('[role=combobox],[role=listbox],input,textarea,[role=switch]')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); } else if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
  };
  const n = shot.attempt;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92vh] gap-3 overflow-y-auto p-4 sm:max-w-5xl sm:p-6" onKeyDown={onKey}>
        <DialogHeader className="pr-6">
          <DialogTitle className="break-all font-mono text-base">{shot.page}</DialogTitle>
          <DialogDescription>Attempt {n}, {widthLabel(shot.width)}. Use the left and right arrow keys to move between screenshots.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <Button type="button" variant="outline" size="icon" className="size-11 sm:size-9" disabled={idx === 0} onClick={() => go(idx - 1)} aria-label="Previous screenshot"><ChevronLeft /></Button>
          <Button type="button" variant="outline" size="icon" className="size-11 sm:size-9" disabled={idx >= list.length - 1} onClick={() => go(idx + 1)} aria-label="Next screenshot"><ChevronRight /></Button>
          <span className="pb-2 text-xs text-muted-foreground" aria-live="polite">{idx + 1} of {list.length}</span>
          <div className="min-w-0 flex-1 basis-40 space-y-1">
            <Label htmlFor="shot-page" className="text-xs">Page</Label>
            <Select value={shot.page} onValueChange={(p) => pick(p, widths.includes(shot.width) ? shot.width : (list.find((s) => s.page === p)?.width ?? shot.width))}>
              <SelectTrigger id="shot-page" className="h-11 w-full sm:h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{pages.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex gap-1" role="group" aria-label="Width">
            {[...new Set(list.map((s) => s.width))].sort((a, b) => a - b).map((w) => (
              <Button key={w} type="button" size="sm" variant={w === shot.width ? 'secondary' : 'outline'} aria-pressed={w === shot.width} disabled={!list.some((s) => s.page === shot.page && s.width === w)} className="h-11 sm:h-9" onClick={() => pick(shot.page, w)}>{w} px</Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2"><Switch id="shot-compare" checked={compare} onCheckedChange={setCompare} /><Label htmlFor="shot-compare" className="min-h-6">Compare with attempt {n - 1}</Label></div>
        {compare && !prev && <Note>Attempt {n - 1} has no screenshot of this page at this width (it may not have run, or its screenshots were pruned).</Note>}
        <div className={cn('grid gap-3', prev && 'md:grid-cols-2')}>
          {prev && <figure className="min-w-0 space-y-1"><figcaption className="text-xs text-muted-foreground">Attempt {n - 1}</figcaption><div className="max-h-[60vh] overflow-auto rounded-md border"><img src={shotUrl(taskId, prev.id, 'full')} alt={`${prev.page} at ${widthLabel(prev.width)}, attempt ${prev.attempt}`} className="mx-auto w-full" /></div></figure>}
          <figure className="min-w-0 space-y-1">
            {prev && <figcaption className="text-xs text-muted-foreground">Attempt {n}</figcaption>}
            <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted"><img src={shotUrl(taskId, shot.id, 'full')} alt={`${shot.page} at ${widthLabel(shot.width)}, attempt ${shot.attempt}`} className="mx-auto w-full" /></div>
          </figure>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>HTTP status: <b>{shot.httpStatus ?? 'none'}</b></span>
            {shot.title && <span className="min-w-0 break-words">Title: <b>{shot.title}</b></span>}
            <Badges shot={shot} />
          </div>
          {shot.problems.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{shot.problems.map((p, i) => <li key={i} className="break-words">{p.message}</li>)}</ul>}
          <Detail title="Console errors" items={shot.consoleErrors} />
          <Detail title="Failed requests" items={shot.failedRequests.map((r) => `${r.url}${r.status ? ` (${r.status})` : ''}${r.error ? `: ${r.error}` : ''}`)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
