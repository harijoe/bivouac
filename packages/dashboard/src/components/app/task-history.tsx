import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronRight, CircleCheck, CircleX, FileDiff, Link2, Loader2, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import type { AttemptShots, AttemptSummary, AttemptsPage, HistoryMarker, TaskEvent } from '@bivouac/shared';
import { ago, api, fmtUsd, type TaskView } from '@/api';
import { AsyncButton } from './async-button';
import { AttemptShotsSection, type ShotsState } from './attempt-shots';
import { DiffPanel, useDiffs, type DiffState, type Which } from './diff-view';
import { FeedList } from './task-feed';
import { Hl, HighlightContext } from './highlight';
import { EmptyState, ErrorNote } from './misc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { applyEvent, attemptFromHash, emptyHistory, fmtDuration, isScreenshotsEvent, mergeAttempts, mergeEvents, STATE_LABEL, type HistoryState } from '@/lib/history';
import { useDebounced, useNow } from '@/lib/hooks';
import { allFilters, filterItems, toItems, type Filters } from '@/lib/task-items';
import { cn } from '@/lib/utils';

const PAGE = 15;
const FILTERS: { key: keyof Filters; label: string }[] = [
  { key: 'messages', label: 'Agent messages' }, { key: 'checks', label: 'Checks' }, { key: 'tools', label: 'Tool calls' }, { key: 'instructions', label: 'Instructions' },
];
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// ---------- what happened between two attempts
function MarkerRow({ m, filters }: { m: HistoryMarker; filters: Filters }) {
  if (m.kind === 'instruction') {
    if (!filters.instructions) return null;
    return (
      <li className="rounded-md border-l-2 border-primary bg-muted/50 px-3 py-2 text-sm">
        <b>You</b> <span className="whitespace-pre-wrap break-words"><Hl>{m.text ?? ''}</Hl></span>
        <span className="text-muted-foreground"> · {when(m.at)}{m.queued ? ' · applied at the next attempt' : ''}</span>
      </li>
    );
  }
  if (m.kind === 'limits') return <li className="text-sm text-muted-foreground">Limits changed · {when(m.at)} · {m.text}</li>;
  const label = STATE_LABEL[m.status ?? ''] ?? m.status ?? '';
  const bad = ['failed', 'stuck'].includes(m.status ?? '');
  return (
    <li className="text-sm">
      <div className="flex items-center gap-3" role="separator" aria-label={label}>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className={cn('text-xs font-medium uppercase tracking-wide', bad ? 'text-red-700 dark:text-red-300' : m.status === 'succeeded' ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>{label} · {when(m.at)}</span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      {m.error && <p className="mt-1 line-clamp-3 break-words text-center text-xs text-muted-foreground">{m.error}</p>}
    </li>
  );
}
function Markers({ markers, filters }: { markers: HistoryMarker[]; filters: Filters }) {
  const shown = markers.filter((m) => m.kind !== 'instruction' || filters.instructions);
  if (!shown.length) return null;
  return <ul className="space-y-2 px-1 py-1" aria-label="What happened before the attempt above">{shown.map((m) => <MarkerRow key={m.id} m={m} filters={filters} />)}</ul>;
}

// ---------- one attempt
interface Loaded { events: TaskEvent[]; truncated: boolean }
function CheckBadge({ a, running }: { a: AttemptSummary; running: boolean }) {
  if (running) return <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-300"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />Running</span>;
  if (!a.check) return <span className="text-muted-foreground">No check</span>;
  return a.check.passed
    ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CircleCheck className="size-3.5" aria-hidden="true" />Check passed</span>
    : <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300"><CircleX className="size-3.5" aria-hidden="true" />Check failed ({a.check.exitCode})</span>;
}

/** A titled part of an attempt that loads its content only once expanded. */
function Extra({ id, icon: Icon, title, defaultOpen, children }: { id: string; icon: typeof Camera; title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="border-t pt-2">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id} className="flex min-h-11 w-full items-center gap-2 rounded-md px-1 text-left text-sm font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9">
        <ChevronRight className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" /><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />{title}
      </button>
      {open && <div id={id} className="pt-2">{children}</div>}
    </div>
  );
}
interface Extras { shots: ShotsState; ensureShots: () => void; reloadShots: () => Promise<void>; diffs: Record<string, DiffState>; loadDiff: (w: Which) => Promise<void> }

function AttemptSection({ a, task, now, open, onToggle, loaded, loading, error, retry, live, filters, highlighted, extras }: {
  a: AttemptSummary; task: TaskView; now: number; open: boolean; onToggle: () => void; loaded: Loaded | undefined; loading: boolean; error: string; retry: () => void;
  live: TaskEvent[] | undefined; filters: Filters; highlighted: boolean; extras: Extras;
}) {
  const running = (task.status === 'running' || task.status === 'checking') && task.iteration === a.attempt;
  const isCost = task.costKind === 'cost';
  const items = useMemo(() => filterItems(toItems(mergeEvents(loaded?.events, live)), filters), [loaded, live, filters]);
  const link = () => {
    const url = `${location.origin}${location.pathname}#attempt-${a.attempt}`;
    history.replaceState(null, '', url);
    navigator.clipboard?.writeText(url).then(() => toast.success(`Link to attempt ${a.attempt} copied`), () => toast.message('Link to this attempt', { description: url }));
    if (!navigator.clipboard) toast.message('Link to this attempt', { description: url });
  };
  const bodyId = `attempt-${a.attempt}-body`;
  return (
    <section id={`attempt-${a.attempt}`} aria-labelledby={`attempt-${a.attempt}-title`} className={cn('scroll-mt-20 rounded-lg border bg-card', highlighted && 'ring-2 ring-primary')}>
      <div className="flex items-start gap-1 p-1">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} className="flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight className={cn('mt-0.5 size-4 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <b id={`attempt-${a.attempt}-title`} className="font-semibold">Attempt {a.attempt}</b>
              <span className="text-muted-foreground" title={new Date(a.startedAt).toLocaleString()}>{when(a.startedAt)} <span className="hidden sm:inline">· {ago(a.startedAt, now)}</span></span>
              <span className="text-muted-foreground">{fmtDuration(running ? now - Date.parse(a.startedAt) : a.durationMs)}</span>
              {a.costUsd !== null && <span className="text-muted-foreground" title={isCost ? 'Cost of this attempt' : 'Estimated API equivalent: not money spent with a Claude subscription'}>{isCost ? '' : '≈ '}{fmtUsd(a.costUsd)}</span>}
              <CheckBadge a={a} running={running} />
            </span>
            {a.lastMessage && <span className="line-clamp-2 block break-words text-sm text-muted-foreground"><Hl>{a.lastMessage}</Hl></span>}
          </span>
        </button>
        <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0 sm:size-9" onClick={link} aria-label={`Copy the link to attempt ${a.attempt}`} title="Copy link to this attempt"><Link2 /></Button>
      </div>
      {open && (
        <div id={bodyId} className="space-y-3 border-t px-3 py-3 sm:px-4">
          {error ? <div className="space-y-2"><ErrorNote>{error}</ErrorNote><AsyncButton variant="outline" busyLabel="Loading…" onClick={retry}>Try again</AsyncButton></div>
            : !loaded && loading ? <div className="space-y-2" aria-busy="true" aria-label="Loading this attempt"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-9 w-full" /></div>
            : items.length ? <FeedList items={items} />
            : <p className="text-sm text-muted-foreground">{loaded?.events.length || live?.length ? 'Nothing to show with the current filters.' : running ? 'The agent is starting…' : 'No messages in this attempt.'}</p>}
          {loaded?.truncated && <p className="text-xs text-muted-foreground">This attempt is very long: only its first events are shown here.</p>}
          <Extra id={`attempt-${a.attempt}-shots`} icon={Camera} title="Screenshots" defaultOpen>
            <AttemptShotsSection taskId={task.id} attempt={a.attempt} state={extras.shots} ensure={extras.ensureShots} reload={extras.reloadShots} />
          </Extra>
          <Extra id={`attempt-${a.attempt}-changes`} icon={FileDiff} title="Changes">
            <DiffPanel taskId={task.id} which={a.attempt} state={extras.diffs[String(a.attempt)]} load={extras.loadDiff} />
          </Extra>
        </div>
      )}
    </section>
  );
}

// ---------- the history
/**
 * The task history grouped by attempt, the most recent first. Attempts load a page at a time and their events only when opened;
 * live events (`subscribe`) land in the open attempt without moving the page.
 */
export function TaskHistory({ task, subscribe, reconnects }: { task: TaskView; subscribe: (fn: (e: TaskEvent) => void) => () => void; reconnects: number }) {
  const [h, setH] = useState<HistoryState>(emptyHistory);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState<Record<number, Loaded>>({});
  const [loadingA, setLoadingA] = useState<Record<number, boolean>>({});
  const [errA, setErrA] = useState<Record<number, string>>({});
  const [openA, setOpenA] = useState<Record<number, boolean>>({});
  const [filters, setFilters] = useState<Filters>(allFilters);
  const [text, setText] = useState('');
  const query = useDebounced(text.trim(), 350);
  const [found, setFound] = useState<{ attempts: AttemptSummary[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<number | null>(() => attemptFromHash(location.hash));
  const now = useNow(task.status === 'running' || task.status === 'checking');
  const buffer = useRef<TaskEvent[]>([]);
  const live = useRef(false);
  const lastEvent = useRef(0);
  const scrolled = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const id = task.id;
  const [shots, setShots] = useState<ShotsState>({ data: null, loading: false, error: '' });
  const shotsWanted = useRef(false);
  const { diffs, load: loadDiff } = useDiffs(id);

  // ----- screenshots: one fetch for the whole task, made when the first gallery is shown and again when new shots are announced
  const loadShots = useCallback(async () => {
    shotsWanted.current = true;
    setShots((o) => ({ ...o, loading: true, error: '' }));
    try { const data = await api<AttemptShots[]>('GET', `/api/tasks/${id}/shots?limit=12`); setShots({ data, loading: false, error: '' }); }
    catch (e) { setShots((o) => ({ ...o, loading: false, error: (e as Error).message })); }
  }, [id]);
  const ensureShots = useCallback(() => { if (!shotsWanted.current) void loadShots(); }, [loadShots]);
  useEffect(() => { shotsWanted.current = false; setShots({ data: null, loading: false, error: '' }); }, [id]);

  // ----- first page (or the page that contains the attempt a link points to), then live events
  const loadFirst = useCallback(async (limit: number) => {
    const p = await api<AttemptsPage>('GET', `/api/tasks/${id}/attempts?limit=${Math.min(limit, 500)}`);
    lastEvent.current = p.lastEventId;
    setH((old) => {
      let next = mergeAttempts(old, p, 'replace');
      for (const e of buffer.current) if (e.id > p.lastEventId) next = applyEvent(next, e);
      buffer.current = [];
      return next;
    });
    live.current = true;
    setReady(true); setLoadError('');
  }, [id]);
  useEffect(() => {
    setH(emptyHistory); setLoaded({}); setOpenA({}); setReady(false); live.current = false; buffer.current = [];
    const want = target ?? 0;
    // a link to attempt 12 of 200: load everything newer in one go (headers only), never the whole history
    const limit = want && task.iteration > want ? task.iteration - want + 1 : PAGE;
    loadFirst(Math.max(PAGE, limit)).catch((e) => setLoadError((e as Error).message));
    // only on another task
  }, [id]);
  useEffect(() => subscribe((e) => {
    if (isScreenshotsEvent(e) && shotsWanted.current) void loadShots();
    if (!live.current) { buffer.current.push(e); return; }
    setH((old) => applyEvent(old, e));
  }), [subscribe, loadShots]);
  // the stream dropped and came back: events may have been missed
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!live.current) return;
    setLoaded({});
    if (shotsWanted.current) void loadShots();
    loadFirst(Math.max(PAGE, Math.min(h.attempts.length, 100))).catch(() => {});
  }, [reconnects]);

  // ----- events of an attempt, on demand
  const loadAttempt = useCallback(async (n: number) => {
    setLoadingA((o) => ({ ...o, [n]: true })); setErrA((o) => ({ ...o, [n]: '' }));
    try {
      const r = await api<Loaded>('GET', `/api/tasks/${id}/attempts/${n}/events`);
      setLoaded((o) => ({ ...o, [n]: r }));
    } catch (e) { setErrA((o) => ({ ...o, [n]: (e as Error).message })); } finally { setLoadingA((o) => ({ ...o, [n]: false })); }
  }, [id]);

  const searching_ = query.length >= 2;
  const shown = searching_ ? (found?.attempts ?? []) : h.attempts;
  const newest = h.attempts[0]?.attempt;
  const isOpen = (n: number) => openA[n] ?? (searching_ ? true : n === newest || n === target);
  useEffect(() => {
    for (const a of shown) if (isOpen(a.attempt) && !loaded[a.attempt] && !loadingA[a.attempt] && !errA[a.attempt]) void loadAttempt(a.attempt);
    // isOpen reads the state used below
  }, [shown, openA, loaded, loadingA, errA, target]);

  // ----- a link to an attempt: open it and bring it into view once
  useEffect(() => {
    const f = () => { const n = attemptFromHash(location.hash); if (n) { scrolled.current = false; setTarget(n); } };
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  useEffect(() => {
    if (!ready || !target || scrolled.current) return;
    const el = document.getElementById(`attempt-${target}`);
    if (!el) return;
    scrolled.current = true;
    setOpenA((o) => ({ ...o, [target]: true }));
    el.scrollIntoView({ block: 'start' });
  }, [ready, target, h.attempts.length]);

  // ----- keep the viewport still when a new attempt appears on top while the owner reads further down
  const topHeight = useRef(0);
  const topAttempt = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (topAttempt.current !== undefined && newest !== undefined && newest !== topAttempt.current && el.getBoundingClientRect().top < 0) window.scrollBy(0, el.offsetHeight - topHeight.current);
    topAttempt.current = newest;
    topHeight.current = el.offsetHeight;
  });

  // ----- search
  useEffect(() => {
    if (!searching_) { setFound(null); return; }
    let alive = true;
    setSearching(true);
    (async () => {
      try {
        const s = await api<{ attempts: number[]; truncated: boolean }>('GET', `/api/tasks/${id}/history/search?q=${encodeURIComponent(query)}`);
        const p = s.attempts.length ? await api<AttemptsPage>('GET', `/api/tasks/${id}/attempts?only=${s.attempts.join(',')}`) : { attempts: [] as AttemptSummary[] };
        if (alive) { setFound({ attempts: p.attempts, truncated: s.truncated }); setOpenA({}); }
      } catch (e) { if (alive) { setFound(null); toast.error(`Search failed: ${(e as Error).message}`); } } finally { if (alive) setSearching(false); }
    })();
    return () => { alive = false; };
  }, [id, query, searching_]);

  const older = async () => {
    const oldest = h.attempts.at(-1)?.attempt;
    if (!oldest) return;
    try { const p = await api<AttemptsPage>('GET', `/api/tasks/${id}/attempts?before=${oldest}&limit=${PAGE}`); setH((o) => mergeAttempts(o, p, 'append')); }
    catch (e) { toast.error(`Could not load older attempts: ${(e as Error).message}`); }
  };

  if (loadError) return <div className="space-y-2"><ErrorNote>{loadError}</ErrorNote><AsyncButton variant="outline" busyLabel="Loading…" onClick={() => loadFirst(PAGE).catch((e) => setLoadError((e as Error).message))}>Try again</AsyncButton></div>;
  if (!ready) return <div className="space-y-3" aria-busy="true" aria-label="Loading the history"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  if (!h.attempts.length && !h.trailing.length) return <EmptyState title="Nothing yet">The agent’s attempts appear here, the most recent first, as it works.</EmptyState>;

  const remaining = (h.attempts.at(-1)?.attempt ?? 1) - 1;
  return (
    <HighlightContext.Provider value={searching_ ? query : ''}>
      <div className="space-y-4">
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search messages, checks, tool calls, instructions…" aria-label="Search the history" className="h-11 pl-9 pr-10 sm:h-9" />
            {text && <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-1/2 size-10 -translate-y-1/2 sm:size-8" onClick={() => setText('')} aria-label="Clear the search"><X /></Button>}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <Button key={f.key} type="button" size="sm" variant={filters[f.key] ? 'secondary' : 'outline'} className={cn('h-10 sm:h-8', !filters[f.key] && 'text-muted-foreground line-through')} aria-pressed={filters[f.key]} onClick={() => setFilters((o) => ({ ...o, [f.key]: !o[f.key] }))}>{f.label}</Button>
            ))}
          </div>
          {searching_ && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              {searching ? <><Loader2 className="size-4 animate-spin" aria-hidden="true" />Searching…</> : found ? (found.attempts.length ? `${found.attempts.length} attempt${found.attempts.length === 1 ? '' : 's'} match “${query}”${found.truncated ? ' (the most recent ones are shown)' : ''}.` : `Nothing matches “${query}”.`) : null}
            </p>
          )}
        </div>

        <div ref={list} className="space-y-3">
          {!searching_ && h.trailing.length > 0 && <Markers markers={h.trailing} filters={filters} />}
          {shown.map((a) => (
            <div key={a.attempt} className="space-y-3">
              <AttemptSection a={a} task={task} now={now} open={isOpen(a.attempt)} onToggle={() => setOpenA((o) => ({ ...o, [a.attempt]: !isOpen(a.attempt) }))}
                loaded={loaded[a.attempt]} loading={!!loadingA[a.attempt]} error={errA[a.attempt] ?? ''} retry={() => loadAttempt(a.attempt)} live={h.live[a.attempt]} filters={filters} highlighted={target === a.attempt}
                extras={{ shots, ensureShots, reloadShots: loadShots, diffs, loadDiff }} />
              <Markers markers={a.markers} filters={filters} />
            </div>
          ))}
        </div>

        {!searching_ && h.hasMore && (
          <div className="flex justify-center">
            <AsyncButton variant="outline" className="h-11 sm:h-9" busyLabel="Loading older attempts…" onClick={older}>Show older attempts{remaining > 0 ? ` (${remaining} more)` : ''}</AsyncButton>
          </div>
        )}
      </div>
    </HighlightContext.Provider>
  );
}
