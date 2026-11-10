import { useEffect, useRef, useState } from 'react';
import { Check, CircleDashed, ExternalLink, Loader2, X } from 'lucide-react';
import { ago, api, type UpdateStatus } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { ErrorNote, Note, PageSkeleton } from '@/components/app/misc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAsync, useLoad } from '@/lib/hooks';
import { Markdown } from '@/lib/markdown';
import { useUpdate } from '@/lib/use-update';
import { cn } from '@/lib/utils';
import type { SectionProps } from './types';

const STEP_LABELS: Record<string, string> = {
  backup: 'Back up your data', pull: 'Download the new version', configure: 'Prepare the configuration', restart: 'Restart bivouac', health: 'Check that everything works',
};
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Steps of a running or finished update. */
function Progress({ st, offline }: { st: UpdateStatus; offline: boolean }) {
  const p = st.progress!;
  const idx = p.steps.indexOf(p.step);
  const title = p.state === 'running' ? `Updating to ${p.to}…` : p.state === 'done' ? `Updated to ${p.to}` : p.state === 'rolled_back' ? 'The update did not work. Nothing was lost.' : 'The update failed';
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-2" aria-label="Update steps">
          {p.steps.map((step, i) => {
            const state = p.state === 'done' ? 'done' : i < idx ? 'done' : i === idx ? (p.state === 'running' ? 'now' : 'bad') : 'todo';
            return (
              <li key={step} className={cn('flex min-h-8 items-center gap-2 text-sm', state === 'todo' && 'text-muted-foreground')} aria-current={state === 'now' ? 'step' : undefined}>
                {state === 'done' && <Check className="size-4 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />}
                {state === 'now' && <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />}
                {state === 'bad' && <X className="size-4 text-red-700 dark:text-red-300" aria-hidden="true" />}
                {state === 'todo' && <CircleDashed className="size-4" aria-hidden="true" />}
                <span className={cn(state === 'now' && 'font-medium')}>{STEP_LABELS[step] ?? step}</span>
              </li>
            );
          })}
        </ol>
        {p.state === 'running' && <p className="text-sm text-muted-foreground">{offline ? 'bivouac is restarting. This page reconnects by itself.' : 'This takes about a minute. You can leave this page open.'}</p>}
        {p.state === 'rolled_back' && <Note tone="warn" title={`bivouac is back on version ${p.from}`}>{p.error}</Note>}
        {p.state === 'failed' && <Note tone="error" title="The update failed">{p.error} Try again, or run the installer again over SSH.</Note>}
        {p.state === 'done' && <Note tone="ok">Your projects, tasks and settings are unchanged. Reloading…</Note>}
      </CardContent>
    </Card>
  );
}

function StartUpdate({ st, version, onStart }: { st: UpdateStatus; version: string; onStart: (mode: 'idle' | 'now') => Promise<unknown> }) {
  const [mode, setMode] = useState<'idle' | 'now'>('idle');
  const busyTasks = st.runningTasks > 0;
  const now = busyTasks && mode === 'now';
  return (
    <ConfirmDialog
      trigger={<Button size="lg" className="w-full sm:w-auto">Update to {version}</Button>}
      title={`Update to ${version}`}
      destructive={now}
      confirmLabel={busyTasks ? (now ? 'Stop the tasks and update now' : 'Update when tasks are done') : 'Update now'}
      busyLabel="Starting the update…"
      onConfirm={() => onStart(busyTasks ? mode : 'idle')}
      description={
        <div className="space-y-4 text-left">
          <ul className="list-disc space-y-1 pl-5">
            <li>Your database and settings are backed up first (the last 3 backups are kept).</li>
            <li>bivouac is unavailable for about a minute while it restarts.</li>
            <li>If the new version does not start, bivouac goes back to {st.current} by itself and tells you why.</li>
          </ul>
          {busyTasks ? (
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'idle' | 'now')} className="gap-3" aria-label="When to update">
              <div className="flex items-start gap-3">
                <RadioGroupItem value="idle" id="upd-idle" className="mt-1" />
                <Label htmlFor="upd-idle" className="block font-normal"><b>Update when no task is running</b> (recommended)<br /><span className="text-muted-foreground">{st.runningTasks} {plural(st.runningTasks, 'task is', 'tasks are')} running. No new task starts until the update is done.</span></Label>
              </div>
              <div className="flex items-start gap-3">
                <RadioGroupItem value="now" id="upd-now" className="mt-1" />
                <Label htmlFor="upd-now" className="block font-normal"><b>Update now</b><br /><span className="text-muted-foreground">The running tasks are stopped. You can resume them afterwards.</span></Label>
              </div>
            </RadioGroup>
          ) : <p>No task is running.</p>}
        </div>
      }
    />
  );
}

interface AuditRow { id: number; ts: string; actor: string; action: string; detail: { from?: string; to?: string; error?: string } | null }
const HISTORY_LABEL: Record<string, string> = {
  update_scheduled: 'Update scheduled', update_schedule_cancelled: 'Scheduled update cancelled', update_started: 'Update started', update_succeeded: 'Update succeeded',
  update_rolled_back: 'Update rolled back', update_failed: 'Update failed', auto_update_enabled: 'Automatic updates turned on', auto_update_disabled: 'Automatic updates turned off',
};

function History({ refreshKey }: { refreshKey: string }) {
  const { data, error, loading } = useLoad(() => api<AuditRow[]>('GET', '/api/settings/audit?limit=200'), [refreshKey]);
  const rows = (data ?? []).filter((r) => r.action in HISTORY_LABEL).slice(0, 15);
  return (
    <Card>
      <CardHeader><CardTitle>Update history</CardTitle><CardDescription>Who updated bivouac, and what happened.</CardDescription></CardHeader>
      <CardContent>
        {loading && !data ? <Skeleton className="h-16 w-full" /> : error ? <ErrorNote>{error}</ErrorNote> : rows.length === 0 ? <p className="text-sm text-muted-foreground">No update yet.</p> : (
          <ul className="divide-y">
            {rows.map((r) => (
              <li key={r.id} className="py-2 text-sm">
                <p><b>{HISTORY_LABEL[r.action]}</b>{r.detail?.from && r.detail?.to ? ` · ${r.detail.from} → ${r.detail.to}` : ''}</p>
                <p className="text-muted-foreground">{r.actor} · {ago(r.ts)}{r.detail?.error ? ` · ${r.detail.error}` : ''}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function UpdatesSection({ s, session }: SectionProps) {
  const loadedVersion = useRef(session.version);
  const { st, offline, reload } = useUpdate(s.admin);
  const a = useAsync();
  const startedHere = useRef(false);
  const [switching, setSwitching] = useState(false);

  // once the new version answers, load its dashboard
  useEffect(() => { if (st && st.current !== loadedVersion.current) location.reload(); }, [st]);
  useEffect(() => {
    if (st?.progress?.state === 'done' && startedHere.current) { const t = setTimeout(() => location.reload(), 1500); return () => clearTimeout(t); }
  }, [st]);

  const heading = (
    <div>
      <h2 className="text-lg font-semibold">Updates</h2>
      <p className="text-sm text-muted-foreground">Installed version: <b>{s.version}</b></p>
    </div>
  );
  if (!s.admin) return <div className="space-y-6">{heading}<Note>Only an administrator can update bivouac.</Note></div>;
  if (!st) return <div className="space-y-6">{heading}{offline ? <Note tone="warn">bivouac is not answering. This page reconnects by itself.</Note> : <PageSkeleton rows={2} />}</div>;

  const av = st.available;
  const p = st.progress;
  const showProgress = !!p && (p.state === 'running' || (startedHere.current && p.to === av?.version) || (p.state !== 'done' && p.to === av?.version && Date.now() - Date.parse(p.startedAt) < 3600_000));
  const act = async (fn: () => Promise<unknown>) => { await a.run(async () => { await fn(); await reload(); }); };

  return (
    <div className="space-y-6">
      {heading}
      {showProgress && p && <Progress st={st} offline={offline} />}

      {!showProgress && (
        <Card>
          <CardHeader>
            <CardTitle>{av ? `Version ${av.version} is available` : 'bivouac is up to date'}</CardTitle>
            <CardDescription>
              {st.checkedAt ? `Last checked ${ago(st.checkedAt)}.` : 'Not checked yet.'}
              {av?.publishedAt && <> Published {ago(av.publishedAt)}.</>}
              {av?.url && <> <a href={av.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">View on GitHub<ExternalLink className="size-3" aria-hidden="true" /></a></>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {av && (av.notes ? <div className="rounded-md border p-3"><Markdown text={av.notes} /></div> : <p className="text-sm text-muted-foreground">No release notes.</p>)}
            <ErrorNote>{st.error ? `Could not check for updates: ${st.error}. Check that the server can reach github.com, then try again.` : a.error}</ErrorNote>
            {av && st.scheduled && (
              <div className="space-y-3">
                <Note>Waiting for {st.runningTasks} running {plural(st.runningTasks, 'task', 'tasks')} to finish. The update starts by itself, and no new task starts until then.</Note>
                <AsyncButton variant="outline" busyLabel="Cancelling…" busy={a.busy} className="h-11 sm:h-9" onClick={() => act(() => api('DELETE', '/api/update/schedule'))}>Cancel the update</AsyncButton>
              </div>
            )}
            {av && !st.scheduled && !st.canUpdate && <Note>Updates from the dashboard are not available on this installation. Run the installer again over SSH to update.</Note>}
            {av && !st.scheduled && st.canUpdate && (
              <StartUpdate st={st} version={av.version} onStart={(mode) => { startedHere.current = true; return api('POST', '/api/update/start', { mode }).then(reload); }} />
            )}
            <AsyncButton variant={av ? 'outline' : 'default'} busyLabel="Checking for updates…" className="h-11 sm:h-9" onClick={() => act(() => api('POST', '/api/update/check'))}>Check for updates</AsyncButton>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="auto-update" className="text-base">Update automatically</Label>
            <p className="text-sm text-muted-foreground">New versions are installed at night, only when no task is running, with the same backup and automatic rollback.</p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            {switching && <Loader2 className="size-4 animate-spin" aria-label="Saving…" />}
            <Switch id="auto-update" checked={st.auto} disabled={switching}
              onCheckedChange={async (on) => {
                setSwitching(true);
                try { await api('PUT', '/api/update/auto', { enabled: on }); await reload(); } catch (e) { a.setError((e as Error).message); } finally { setSwitching(false); }
              }} />
          </div>
        </CardContent>
      </Card>

      <History refreshKey={`${st.auto}-${p?.state ?? ''}-${st.scheduled?.version ?? ''}-${st.current}`} />
    </div>
  );
}
