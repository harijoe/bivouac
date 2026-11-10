import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ChevronDown, ChevronUp, Clock, Copy, Download, Loader2, Search, WrapText } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncButton } from './async-button';
import { ErrorNote } from './misc';
import { parseAnsi, spanStyle } from '@/lib/ansi';
import { useDebounced } from '@/lib/hooks';
import { applyHighlight, classifyLine, findMatches, fmtTs, linesToText, matchRanges, mergeLines, trimOldest, type LogLine } from '@/lib/log-lines';
import { cn } from '@/lib/utils';

interface Source { key: string; label: string; kind: string }
interface Page { lines: LogLine[]; hasMore: boolean; cursor: number }
type Conn = 'connecting' | 'open' | 'down';

const ROW_H = 20; // px; rows are fixed-height unless lines wrap
const PAGE = 500;
const enc = encodeURIComponent;
const pageUrl = (id: number, source: string, before?: number, limit = PAGE) => `/api/tasks/${id}/logs?source=${enc(source)}&limit=${limit}${before !== undefined ? `&before=${before}` : ''}`;

const LogRow = memo(function LogRow({ line, showTs, wrap, query, current }: { line: LogLine; showTs: boolean; wrap: boolean; query: string; current: boolean }) {
  const kind = useMemo(() => classifyLine(line.text), [line.text]);
  const spans = useMemo(() => {
    const base = parseAnsi(line.text);
    return query ? applyHighlight(base, matchRanges(base.map((s) => s.text).join(''), query)) : base;
  }, [line.text, query]);
  return (
    <div className={cn('flex min-h-5 gap-3 border-l-2 px-2 font-mono text-xs leading-5', kind === 'error' ? 'border-red-500 bg-red-500/10' : kind === 'warn' ? 'border-amber-500 bg-amber-500/10' : 'border-transparent', wrap ? 'w-full' : 'h-5 w-max min-w-full')}>
      {showTs && <span className="w-[12ch] shrink-0 select-none tabular-nums text-muted-foreground">{fmtTs(line.ts)}</span>}
      <span className={wrap ? 'min-w-0 whitespace-pre-wrap break-all' : 'whitespace-pre'}>
        {spans.map((s, i) => {
          const { className, style } = spanStyle(s);
          const hl = (s as { hl?: boolean }).hl;
          return <span key={i} className={cn(className, hl && (current ? 'rounded-sm bg-orange-400 text-black' : 'rounded-sm bg-yellow-300 text-black dark:bg-yellow-500/70'))} style={hl ? undefined : style}>{s.text}</span>;
        })}
      </span>
    </div>
  );
});

const CONN: Record<string, { label: string; dot: string }> = {
  connecting: { label: 'Connecting…', dot: 'bg-muted-foreground animate-pulse' },
  down: { label: 'Disconnected, retrying…', dot: 'bg-red-500' },
  live: { label: 'Live', dot: 'bg-emerald-500 animate-pulse' },
  uptodate: { label: 'Up to date', dot: 'bg-emerald-500' },
  paused: { label: 'Paused (scrolled up)', dot: 'bg-amber-500' },
};

/** Live log viewer of a task: sources, streaming, history on scroll-up, search, copy and full download. */
export function LogViewer({ taskId, live, status }: { taskId: number; live: boolean; status?: string }) {
  const [sources, setSources] = useState<Source[]>([{ key: 'dev', label: 'Dev server', kind: 'dev' }]);
  const [source, setSource] = useState('dev');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [conn, setConn] = useState<Conn>('connecting');
  const [following, setFollowing] = useState(true);
  const [showTs, setShowTs] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState('');
  const [curId, setCurId] = useState<number | null>(null);
  const [dlCount, setDlCount] = useState(0);
  const debounced = useDebounced(query, 200);

  const scrollRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<LogLine[]>([]);
  const hasMoreRef = useRef(false);
  const followingRef = useRef(true);
  const cursorRef = useRef(0);
  const genRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const anchorRef = useRef<{ id: number; delta: number } | null>(null);

  const setFollow = useCallback((v: boolean) => { followingRef.current = v; setFollowing(v); }, []);
  const setMore = (v: boolean) => { hasMoreRef.current = v; setHasMore(v); };

  // ---- the list of sources (check:N appear as attempts start)
  useEffect(() => {
    let dead = false;
    api<Source[]>('GET', `/api/tasks/${taskId}/logs/sources`).then((s) => { if (!dead && s.length) setSources(s); }).catch(() => { /* keep the default source */ });
    return () => { dead = true; };
  }, [taskId, status, live]);

  // ---- first page, then the live stream from its cursor; reconnects with the last cursor
  useEffect(() => {
    const gen = ++genRef.current;
    let dead = false, es: EventSource | null = null, timer: number | undefined;
    linesRef.current = []; cursorRef.current = 0; anchorRef.current = null;
    setLines([]); setMore(false); setLoading(true); setError(''); setConn('connecting'); setFollow(true); setCurId(null);

    const append = (incoming: LogLine[]) => {
      const merged = mergeLines(linesRef.current, incoming);
      if (merged === linesRef.current) return;
      // trim the oldest lines only while following: the reader is not looking at them
      const next = followingRef.current ? trimOldest(merged) : merged;
      if (next.length < merged.length) setMore(true);
      linesRef.current = next; setLines(next);
    };
    const open = () => {
      if (dead) return;
      es = new EventSource(`/api/tasks/${taskId}/logs/stream?source=${enc(source)}&after=${cursorRef.current}`);
      es.onopen = () => setConn('open');
      es.addEventListener('lines', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { lines: LogLine[]; cursor: number };
        cursorRef.current = d.cursor; setConn('open'); append(d.lines);
      });
      es.onerror = () => { es?.close(); setConn('down'); timer = window.setTimeout(open, 2000); };
    };
    const start = () => {
      api<Page>('GET', pageUrl(taskId, source)).then((p) => {
        if (dead) return;
        cursorRef.current = p.cursor; linesRef.current = mergeLines([], p.lines); setLines(linesRef.current); setMore(p.hasMore); setLoading(false); setError('');
        open();
      }).catch((e: Error) => {
        if (dead) return;
        setLoading(false); setConn('down'); setError(`Could not load the logs: ${e.message}. Retrying…`);
        timer = window.setTimeout(start, 3000);
      });
    };
    start();
    return () => { dead = true; es?.close(); clearTimeout(timer); if (genRef.current === gen) genRef.current++; };
  }, [taskId, source, setFollow]);

  // ---- virtualisation
  const getItemKey = useCallback((i: number) => lines[i]?.id ?? i, [lines]);
  const estimateSize = useCallback(() => ROW_H, []);
  const v = useVirtualizer({ count: lines.length, getScrollElement: () => scrollRef.current, estimateSize, overscan: 24, getItemKey });
  const items = v.getVirtualItems();
  const total = v.getTotalSize();

  useEffect(() => { v.measure(); }, [wrap, v]);

  // Keep the reader's place after older lines were added above, otherwise stay glued to the bottom while following.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const a = anchorRef.current;
    if (a) {
      anchorRef.current = null;
      const m = v.measurementsCache[lines.findIndex((l) => l.id === a.id)];
      if (m) el.scrollTop = m.start - a.delta;
      return;
    }
    if (followingRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, total, following, v]);

  const loadOlder = useCallback(async () => {
    const cur = linesRef.current;
    if (loadingOlderRef.current || !hasMoreRef.current || !cur.length) return;
    const gen = genRef.current;
    loadingOlderRef.current = true; setLoadingOlder(true);
    try {
      const p = await api<Page>('GET', pageUrl(taskId, source, cur[0].id));
      if (gen !== genRef.current) return;
      const el = scrollRef.current, first = v.getVirtualItems()[0], at = first && linesRef.current[first.index];
      if (el && at) anchorRef.current = { id: at.id, delta: first.start - el.scrollTop };
      linesRef.current = mergeLines(linesRef.current, p.lines);
      setLines(linesRef.current); setMore(p.hasMore && p.lines.length > 0);
    } catch (e) {
      if (gen === genRef.current) toast.error(`Could not load earlier lines: ${(e as Error).message}`);
    } finally { loadingOlderRef.current = false; if (gen === genRef.current) setLoadingOlder(false); }
  }, [taskId, source, v]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom !== followingRef.current) setFollow(atBottom);
    if (el.scrollTop < 200) void loadOlder();
  };

  // ---- search
  const matches = useMemo(() => findMatches(lines, debounced), [lines, debounced]);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const jump = useCallback((index: number) => { setFollow(false); v.scrollToIndex(index, { align: 'center' }); }, [setFollow, v]);
  useEffect(() => {
    const m = matchesRef.current;
    if (!debounced || !m.length) { setCurId(null); return; }
    const idx = m[m.length - 1]; // start from the most recent match
    setCurId(linesRef.current[idx]?.id ?? null); jump(idx);
  }, [debounced, jump]);
  const pos = curId === null ? -1 : matches.findIndex((i) => lines[i].id === curId);
  const go = (dir: 1 | -1) => {
    const n = matches.length;
    if (!n) return;
    const next = pos < 0 ? (dir > 0 ? 0 : n - 1) : (pos + dir + n) % n;
    setCurId(lines[matches[next]].id); jump(matches[next]);
  };

  // ---- copy / download
  const copy = async (all: boolean) => {
    const r = v.range;
    const sel = all || !r ? lines : lines.slice(r.startIndex, r.endIndex + 1);
    try { await navigator.clipboard.writeText(linesToText(sel, showTs)); toast.success(`Copied ${sel.length.toLocaleString()} lines`); }
    catch { toast.error('The browser blocked copying (it needs HTTPS). Use Download instead.'); }
  };
  const download = async () => {
    setDlCount(0);
    try {
      const chunks: LogLine[][] = [];
      let before: number | undefined, n = 0;
      for (;;) {
        const p = await api<Page>('GET', pageUrl(taskId, source, before, 2000));
        if (p.lines.length) { chunks.unshift(p.lines); n += p.lines.length; setDlCount(n); }
        if (!p.hasMore || !p.lines.length) break;
        before = p.lines[0].id;
      }
      const text = linesToText(chunks.flat(), true) + '\n';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = `task-${taskId}-${source.replace(/[^\w.-]/g, '_')}.log`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast.success(`Downloaded ${n.toLocaleString()} lines`);
    } catch (e) { toast.error(`Could not download the log: ${(e as Error).message}`); }
  };

  const connKey = conn === 'down' ? 'down' : conn === 'connecting' ? 'connecting' : !following ? 'paused' : live ? 'live' : 'uptodate';
  const ind = CONN[connKey];
  const sourceItems = sources.some((s) => s.key === source) ? sources : [...sources, { key: source, label: source, kind: '' }];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger aria-label="Log source" className="h-11 w-full sm:h-9 sm:w-52"><SelectValue /></SelectTrigger>
          <SelectContent>{sourceItems.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex min-w-48 flex-1 items-center gap-1">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label="Search the log" className="h-11 pl-8 sm:h-9"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } }}
            />
          </div>
          <span className="min-w-14 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {debounced ? (matches.length ? `${pos + 1}/${matches.length}` : 'No match') : ''}
          </span>
          <Button type="button" variant="outline" size="icon" className="size-11 sm:size-9" aria-label="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => go(-1)}><ChevronUp /></Button>
          <Button type="button" variant="outline" size="icon" className="size-11 sm:size-9" aria-label="Next match (Enter)" disabled={!matches.length} onClick={() => go(1)}><ChevronDown /></Button>
        </div>
        <Button type="button" variant="outline" className="h-11 sm:h-9" aria-pressed={showTs} onClick={() => setShowTs((x) => !x)}><Clock />Time</Button>
        <Button type="button" variant="outline" className="h-11 sm:h-9" aria-pressed={wrap} onClick={() => setWrap((x) => !x)}><WrapText />Wrap</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" variant="outline" className="h-11 sm:h-9" disabled={!lines.length}><Copy />Copy</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void copy(false)}>Copy visible lines</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copy(true)}>Copy all loaded lines ({lines.length.toLocaleString()})</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AsyncButton type="button" variant="outline" className="h-11 sm:h-9" busyLabel={dlCount ? `Downloading… ${dlCount.toLocaleString()} lines` : 'Downloading…'} onClick={download}><Download />Download</AsyncButton>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2" role="status"><span className={cn('size-2 rounded-full', ind.dot)} aria-hidden="true" />{ind.label}</span>
        <span className="flex items-center gap-3">
          <span className="tabular-nums">{lines.length.toLocaleString()} lines{hasMore ? ' loaded' : ''}</span>
          {hasMore && <AsyncButton type="button" variant="ghost" size="sm" className="h-9" busy={loadingOlder} busyLabel="Loading earlier lines…" onClick={() => loadOlder()}>Load earlier lines</AsyncButton>}
        </span>
      </div>
      <ErrorNote>{error}</ErrorNote>

      <div className="relative">
        <div ref={scrollRef} onScroll={onScroll} tabIndex={0} role="log" aria-label="Task log" className="h-[65vh] min-h-80 overflow-auto overscroll-contain rounded-md border bg-muted/30">
          <div className="relative" style={{ height: total }}>
            {items.map((vi) => {
              const line = lines[vi.index];
              return (
                <div key={vi.key} data-index={vi.index} ref={wrap ? v.measureElement : undefined} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${vi.start}px)` }}>
                  <LogRow line={line} showTs={showTs} wrap={wrap} query={debounced} current={line.id === curId} />
                </div>
              );
            })}
          </div>
        </div>
        {loading && (
          <div className="absolute inset-0 space-y-2 rounded-md border bg-background p-3" aria-busy="true" aria-label="Loading the logs">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-4" style={{ width: `${40 + ((i * 37) % 55)}%` }} />)}
          </div>
        )}
        {!loading && !lines.length && !error && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            <p className="font-medium text-foreground">Waiting for output…</p>
            <p>Nothing was written to this log yet. New lines appear here as soon as they come, there is nothing to refresh.</p>
          </div>
        )}
        {!following && lines.length > 0 && (
          <Button type="button" size="lg" className="absolute right-4 bottom-4 h-11 shadow-lg" onClick={() => setFollow(true)}><ArrowDown />Back to live</Button>
        )}
      </div>
    </div>
  );
}
