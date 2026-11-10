import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { api, type Share, type TaskView } from '@/api';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AsyncButton } from './async-button';
import { CopyField, EmptyState, ErrorNote } from './misc';
import { useAsync } from '@/lib/hooks';

const DURATIONS = [['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['never', 'No expiry']] as const;
const expiry = (s: Share) => (s.expiresAt ? `expires ${new Date(s.expiresAt * 1000).toLocaleString()}` : 'no expiry');

/** Share links of the preview: create with a duration, copy (one per port), revoke. */
export function TaskShares({ task, shares, reload }: { task: TaskView; shares: Share[]; reload: () => Promise<void> }) {
  const [dur, setDur] = useState<string>('24h');
  const a = useAsync();
  const active = shares.filter((s) => s.active);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Anyone with a link can view this preview, and only this preview, until it expires or you revoke it.</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="share-duration">Link duration</Label>
          <Select value={dur} onValueChange={setDur}>
            <SelectTrigger id="share-duration" className="h-11 w-44 sm:h-9"><SelectValue /></SelectTrigger>
            <SelectContent>{DURATIONS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <AsyncButton className="h-11 sm:h-9" busyLabel="Creating the link…" onClick={() => a.run(async () => { await api('POST', `/api/tasks/${task.id}/shares`, { duration: dur }); await reload(); })}><Link2 />Create a link</AsyncButton>
      </div>
      <ErrorNote>{a.error}</ErrorNote>
      {active.length === 0 && <EmptyState title="No active links">Pick a duration and create a link to show this preview to someone.</EmptyState>}
      {active.map((s) => (
        <div key={s.id} className="space-y-3 rounded-lg border p-3">
          {(s.urls?.length ?? 0) > 1
            ? s.urls!.map((u) => <CopyField key={u.name} value={u.url} label={`${u.name} · ${expiry(s)}`} />)
            : <CopyField value={s.url ?? ''} label={`Link · ${expiry(s)}`} />}
          <AsyncButton variant="outline" className="h-11 sm:h-9" busyLabel="Revoking…" onClick={() => a.run(async () => { await api('DELETE', `/api/tasks/${task.id}/shares/${s.id}`); await reload(); })}>Revoke this link</AsyncButton>
        </div>
      ))}
    </div>
  );
}
