import { useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AsyncButton } from './async-button';
import { ErrorNote } from './misc';

/**
 * Confirmation for a dangerous or irreversible action. `onConfirm` may return a promise: the button then shows
 * `busyLabel` and the dialog closes when it resolves, or shows its error and stays open.
 */
export function ConfirmDialog({ trigger, title, description, confirmLabel = 'Confirm', busyLabel = 'Working…', destructive = true, onConfirm }: {
  trigger: ReactNode; title: string; description: ReactNode; confirmLabel?: string; busyLabel?: string; destructive?: boolean; onConfirm: () => unknown | Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (busy) return; setOpen(o); if (!o) setError(''); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild><div>{description}</div></DialogDescription>
        </DialogHeader>
        <ErrorNote>{error}</ErrorNote>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <AsyncButton variant={destructive ? 'destructive' : 'default'} busyLabel={busyLabel} onClick={async () => {
            setError(''); setBusy(true);
            try { await onConfirm(); setOpen(false); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
          }}>{confirmLabel}</AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
