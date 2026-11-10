import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, ApiError, type TaskView } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AsyncButton } from './async-button';
import { ErrorNote } from './misc';
import { navigate } from '@/lib/router';
import { useAsync } from '@/lib/hooks';

/** Deleting asks once; when the branch has work that was never pushed, the daemon says so (UNPUSHED) and we ask a second, sharper time. */
function DeleteTask({ task }: { task: TaskView }) {
  const [open, setOpen] = useState(false);
  const [unpushed, setUnpushed] = useState('');
  const [error, setError] = useState('');
  const close = (o: boolean) => { setOpen(o); if (!o) { setUnpushed(''); setError(''); } };
  const del = async () => {
    setError('');
    try {
      await api('DELETE', `/api/tasks/${task.id}${unpushed ? '?force=1' : ''}`);
      navigate(`/projects/${task.projectName}`);
    } catch (e) {
      if (!unpushed && e instanceof ApiError && e.body?.code === 'UNPUSHED') setUnpushed(e.message);
      else setError((e as Error).message);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild><Button variant="destructive" className="h-11 sm:h-9"><Trash2 />Delete this task</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{unpushed ? 'Delete and lose unpushed work?' : 'Delete this task?'}</DialogTitle>
          <DialogDescription asChild>
            <div>{unpushed
              ? <>{unpushed}. If you delete the task now, this work is lost for good. Cancel and push the branch first to keep it.</>
              : <>The sandbox, its logs and its share links are removed. The branch on GitHub, if pushed, stays.</>}</div>
          </DialogDescription>
        </DialogHeader>
        <ErrorNote>{error}</ErrorNote>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
          <AsyncButton variant="destructive" busyLabel="Deleting…" onClick={del}>{unpushed ? 'Delete anyway' : 'Delete'}</AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TaskManage({ task }: { task: TaskView }) {
  const [newName, setNewName] = useState('');
  const a = useAsync();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void a.run(async () => { const t = await api<TaskView>('POST', `/api/tasks/${task.id}/rename`, { name: newName }); navigate(`/projects/${t.projectName}/${t.name}#manage`, true); });
  };
  return (
    <div className="space-y-8">
      <form className="space-y-3" onSubmit={submit}>
        <div className="space-y-1.5">
          <Label htmlFor="rename">Rename the task</Label>
          <Input id="rename" className="h-11 max-w-sm font-mono sm:h-9" value={newName} placeholder={task.name} onChange={(e) => setNewName(e.target.value.toLowerCase())} pattern="[a-z0-9]([a-z0-9\-]{0,38}[a-z0-9])?" title="Lowercase letters, digits and dashes, up to 40 characters" autoComplete="off" />
          <p className="text-sm text-muted-foreground">The preview address changes immediately and existing share links stop working. The git branch keeps its name.</p>
        </div>
        <ErrorNote>{a.error}</ErrorNote>
        <AsyncButton type="submit" className="h-11 sm:h-9" disabled={!newName || newName === task.name} busy={a.busy} busyLabel="Renaming…">Rename</AsyncButton>
      </form>
      <div className="space-y-3 rounded-lg border border-destructive/40 p-4">
        <h3 className="font-medium text-destructive">Danger zone</h3>
        <p className="text-sm text-muted-foreground">Deleting a task cannot be undone.</p>
        <DeleteTask task={task} />
      </div>
    </div>
  );
}
