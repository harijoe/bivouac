import { RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import type { TaskView } from '@/api';
import { ago, api } from '@/api';
import { useAsync, useNow } from '@/lib/hooks';
import { previewIsBroken, restartNote, retryInSeconds } from '@/lib/preview';
import { AsyncButton } from './async-button';
import { ErrorNote, Note } from './misc';

/** The state of the live preview: a banner when it is unhealthy or down, a discreet line when it had to be restarted. */
export function PreviewHealth({ task, onShowLogs, onChanged }: { task: TaskView; onShowLogs: () => void; onChanged: () => Promise<void> }) {
  const p = task.preview;
  const now = useNow(!!p && p.state === 'unhealthy');
  const a = useAsync();
  if (!p) return null;
  const restart = () => a.run(async () => {
    await api('POST', `/api/tasks/${task.id}/preview/restart`, {});
    toast.success('The preview is restarting');
    await onChanged();
  });
  if (!previewIsBroken(p)) {
    const note = restartNote(p);
    return note ? <p className="text-xs text-muted-foreground">Preview {note}.</p> : null;
  }
  const down = p.state === 'down';
  const secs = retryInSeconds(p, now);
  const logs = <button type="button" onClick={onShowLogs} className="font-medium underline underline-offset-4">See the dev server log</button>;
  return (
    <div className="space-y-2">
      <Note tone="warn" title={`Preview unavailable since ${ago(p.since)}`}>
        <span className="block" title={new Date(p.since).toLocaleString()}>
          {down
            ? `bivouac gave up after ${p.restarts} ${p.restarts === 1 ? 'restart' : 'restarts'}. Fix the cause, then restart the preview.`
            : `Not answering. ${p.restarts} ${p.restarts === 1 ? 'restart' : 'restarts'} so far${secs !== null ? `, next retry in ${secs} s` : ', a restart is planned'}.`}
        </span>
        {p.cause && <span className="mt-1 block break-words">Last cause: <code className="font-mono text-xs">{p.cause}</code></span>}
        <span className="mt-2 flex flex-wrap items-center gap-3">
          <AsyncButton variant="outline" size="sm" className="h-11 sm:h-8" busyLabel="Restarting the preview…" onClick={restart}><RotateCw />Restart preview</AsyncButton>
          {logs}
        </span>
      </Note>
      <ErrorNote>{a.error}</ErrorNote>
    </div>
  );
}
