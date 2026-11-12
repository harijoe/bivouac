import { useState } from 'react';
import { Check, Copy, PackageOpen, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ago, api, type ProjectWithTotals } from '@/api';
import type { EnvSnapshot } from '@bivouac/shared';
import { fmtBytes, shortFingerprint } from '@/lib/project-env';
import { useLoad } from '@/lib/hooks';
import { ConfirmDialog } from './confirm-dialog';
import { Note } from './misc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

interface SnapshotsData { keep: number; current: string | null; snapshots: EnvSnapshot[]; bytes: number }

function Fingerprint({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); } catch { /* not https: nothing to do */ }
    setDone(true); setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" onClick={copy} title={`${value} (click to copy)`} aria-label={`Copy the full fingerprint ${value}`}
      className="inline-flex min-h-11 items-center gap-1 rounded font-mono text-xs underline-offset-4 hover:underline sm:min-h-0">
      {shortFingerprint(value)}{done ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
    </button>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 text-sm font-medium">{children}</dd></div>;
}

export function EnvSnapshots({ p, admin }: { p: ProjectWithTotals; admin: boolean }) {
  const q = useLoad(() => api<SnapshotsData>('GET', `/api/projects/${p.id}/snapshots`), [p.id]);
  const d = q.data;
  const cur = d?.snapshots.find((s) => s.current) ?? null;
  const list = d ? [...d.snapshots].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) : [];
  return (
    <section className="space-y-4 p-4" aria-labelledby={`env-title-${p.id}`}>
      <div className="max-w-2xl space-y-1">
        <h3 id={`env-title-${p.id}`} className="font-medium">Environment snapshot <span className="font-normal text-muted-foreground">· {p.name}</span></h3>
        <p className="text-sm text-muted-foreground">After a task's setup succeeds, bivouac keeps the installed dependencies so the next task of this project with the same lock files, setup and runtime starts faster. Setup still runs and stays correct if the snapshot is missing or outdated. At most {d?.keep ?? 'a few'} snapshots are kept per project; the oldest unused ones are removed automatically.</p>
      </div>
      {q.error && <Note tone="error" title="The snapshots could not be loaded">{q.error} <Button variant="link" className="h-auto p-0 text-current underline" onClick={q.reload}>Try again</Button></Note>}
      {!d && !q.error && <div className="space-y-2" aria-busy="true" aria-label="Loading snapshots"><Skeleton className="h-16 w-full" /><Skeleton className="h-12 w-full" /></div>}
      {d && d.snapshots.length === 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          <PackageOpen className="size-5 shrink-0" aria-hidden="true" />No snapshot yet: the first task whose setup succeeds creates one.
        </div>
      )}
      {d && d.snapshots.length > 0 && (
        <>
          {cur ? (
            <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 sm:grid-cols-5">
              <Fact label="Current snapshot">{new Date(cur.createdAt).toLocaleDateString()}</Fact>
              <Fact label="Size">{fmtBytes(cur.bytes)}</Fact>
              <Fact label="Fingerprint"><Fingerprint value={cur.fingerprint} /></Fact>
              <Fact label="Used by">{cur.uses} task{cur.uses === 1 ? '' : 's'}</Fact>
              <Fact label="Last used">{ago(cur.lastUsedAt)}</Fact>
            </dl>
          ) : <Note>None of the kept snapshots matches what a new task would ask for (lock files, setup or runtime changed): the next task builds a new one.</Note>}
          <ul className="divide-y rounded-lg border" aria-label="Kept snapshots">
            {list.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
                  <Fingerprint value={s.fingerprint} />
                  {s.current && <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">Current</Badge>}
                  <span>{fmtBytes(s.bytes)}</span>
                  <span className="text-muted-foreground">built {ago(s.createdAt)} · {s.uses} use{s.uses === 1 ? '' : 's'} · last used {ago(s.lastUsedAt)}</span>
                </div>
                {admin && (
                  <ConfirmDialog
                    trigger={<Button variant="ghost" size="sm" className="h-11 sm:h-8" aria-label={`Delete snapshot ${shortFingerprint(s.fingerprint)}`}><Trash2 />Delete</Button>}
                    title="Delete this snapshot?" confirmLabel="Delete snapshot" busyLabel="Deleting…"
                    description="The next task that needs it runs setup from scratch and builds a new one."
                    onConfirm={async () => { await api('DELETE', `/api/projects/${p.id}/snapshots/${s.id}`); toast.success('Snapshot deleted'); q.reload(); }}
                  />
                )}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{list.length} of {d.keep} kept · {fmtBytes(d.bytes)} in total</p>
        </>
      )}
      {admin && d && d.snapshots.length > 0 && (
        <ConfirmDialog
          trigger={<Button variant="outline" className="h-11 sm:h-9">Rebuild</Button>}
          title={`Rebuild the environment of ${p.name}?`} confirmLabel="Discard snapshots" busyLabel="Discarding…"
          description="This discards all the snapshots of the project. Nothing is built right away: the next task of the project runs setup from scratch and creates a fresh snapshot."
          onConfirm={async () => { const r = await api<{ removed: number }>('POST', `/api/projects/${p.id}/snapshots/rebuild`); toast.success(`${r.removed} snapshot${r.removed === 1 ? '' : 's'} discarded. The next task builds a fresh one.`); q.reload(); }}
        />
      )}
    </section>
  );
}
