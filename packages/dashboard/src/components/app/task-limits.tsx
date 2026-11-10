import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { api, fmtUsd, type TaskView } from '@/api';
import { AsyncButton } from './async-button';
import { ErrorNote } from './misc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAsync } from '@/lib/hooks';

/** A budget that leaves room: 1.5 times what was spent, rounded up to a multiple of 5. */
export const suggestBudget = (spent: number) => Math.max(5, Math.ceil((spent * 1.5) / 5) * 5);

/** Budget, number of attempts and success command of an existing task. They apply from the next attempt. */
export function TaskLimits({ task, onSaved }: { task: TaskView; onSaved: (t: TaskView) => void }) {
  const [cost, setCost] = useState(String(task.maxCostUsd));
  const [iters, setIters] = useState(String(task.maxIterations));
  const [cmd, setCmd] = useState(task.successCommand);
  const a = useAsync();
  // follow changes made elsewhere (an assistant, another tab) while the form is untouched
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!touched) { setCost(String(task.maxCostUsd)); setIters(String(task.maxIterations)); setCmd(task.successCommand); } }, [task.maxCostUsd, task.maxIterations, task.successCommand, touched]);
  const dirty = Number(cost) !== task.maxCostUsd || Number(iters) !== task.maxIterations || cmd.trim() !== task.successCommand;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const t = await api<TaskView>('PATCH', `/api/tasks/${task.id}`, { maxCostUsd: Number(cost), maxIterations: Number(iters), successCommand: cmd });
      setTouched(false); onSaved(t); toast.success('Limits saved. They apply from the next attempt.');
    });
  };
  const isCost = task.costKind === 'cost';
  return (
    <form className="space-y-4" onSubmit={submit} aria-labelledby="limits-title">
      <div>
        <h3 id="limits-title" className="font-medium">Budget and success command</h3>
        <p className="text-sm text-muted-foreground">Change them while the task exists, for example to let it finish. They apply from the next attempt; an attempt that is running keeps its limit.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="limit-cost">Budget (USD)</Label>
          <Input id="limit-cost" type="number" inputMode="decimal" min="0.01" step="any" className="h-11 sm:h-9" value={cost} onChange={(e) => { setCost(e.target.value); setTouched(true); }} required />
          <p className="text-sm text-muted-foreground">{fmtUsd(task.usage.costUsd)} {isCost ? 'spent' : 'used (estimated API equivalent)'} so far.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="limit-iters">Maximum attempts</Label>
          <Input id="limit-iters" type="number" inputMode="numeric" min="1" max="1000" step="1" className="h-11 sm:h-9" value={iters} onChange={(e) => { setIters(e.target.value); setTouched(true); }} required />
          <p className="text-sm text-muted-foreground">{task.iteration} made so far.</p>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="limit-cmd">Success command</Label>
        <Textarea id="limit-cmd" rows={2} className="font-mono text-sm" value={cmd} onChange={(e) => { setCmd(e.target.value); setTouched(true); }} required />
        <p className="text-sm text-muted-foreground">Runs after each attempt; the task is done when it exits with 0.</p>
      </div>
      <ErrorNote>{a.error}</ErrorNote>
      <AsyncButton type="submit" className="h-11 sm:h-9" disabled={!dirty} busy={a.busy} busyLabel="Saving…">Save limits</AsyncButton>
    </form>
  );
}

/**
 * Resume. A task that stopped on its budget cannot do anything with a plain resume, and one that ran out of attempts needs a
 * decision too: both ask for the new limit in a dialog (pre-filled with a suggestion).
 */
export function ResumeButton({ task, variant, onDone }: { task: TaskView; variant: 'default' | 'outline'; onDone: () => Promise<unknown> | void }) {
  const needsBudget = task.status === 'budget_exceeded';
  const needsAttempts = task.status === 'max_iterations';
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const a = useAsync();
  const plain = useAsync();
  useEffect(() => { if (open) setValue(String(needsBudget ? suggestBudget(task.usage.costUsd) : task.iteration + 10)); }, [open, needsBudget, task.usage.costUsd, task.iteration]);
  if (!needsBudget && !needsAttempts) {
    return <AsyncButton variant={variant} className="h-11 sm:h-9" busy={plain.busy} busyLabel="Resuming…" onClick={() => plain.run(async () => { await api('POST', `/api/tasks/${task.id}/resume`, {}); await onDone(); })}><Play />Resume</AsyncButton>;
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api('POST', `/api/tasks/${task.id}/resume`, needsBudget ? { maxCostUsd: Number(value) } : { maxIterations: Number(value) });
      setOpen(false); await onDone();
    });
  };
  const isCost = task.costKind === 'cost';
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) a.setError(''); }}>
      <DialogTrigger asChild><Button variant={variant} className="h-11 sm:h-9"><Play />Resume</Button></DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{needsBudget ? 'Raise the budget to continue' : 'Allow more attempts to continue'}</DialogTitle>
            <DialogDescription>
              {needsBudget
                ? <>The task used {fmtUsd(task.usage.costUsd)} {isCost ? '' : '(estimated API equivalent) '}of its {fmtUsd(task.maxCostUsd)} budget. It cannot go on without a higher limit.</>
                : <>The agent made its {task.iteration} attempts out of {task.maxIterations}. Choose how many it may make in total.</>}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="raise">{needsBudget ? 'New budget (USD, total for the task)' : 'New maximum of attempts (total)'}</Label>
            <Input id="raise" type="number" inputMode={needsBudget ? 'decimal' : 'numeric'} step={needsBudget ? 'any' : '1'} min={needsBudget ? task.usage.costUsd : task.iteration + 1} className="h-11 sm:h-9" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
          </div>
          <ErrorNote>{a.error}</ErrorNote>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <AsyncButton type="submit" busy={a.busy} busyLabel="Resuming…"><Play />Resume</AsyncButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
