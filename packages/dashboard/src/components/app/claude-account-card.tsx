import { useEffect, useState } from 'react';
import { CalendarClock, KeyRound, Star, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ClaudeAccount } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { claudeExpiry, type ExpiryTone } from '@/components/app/claude-expiry';
import { ClaudeConnect } from '@/components/app/claude-connect';
import { ErrorNote } from '@/components/app/misc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAsync } from '@/lib/hooks';
import { cn } from '@/lib/utils';

const TONE: Record<ExpiryTone, string> = {
  ok: 'text-muted-foreground', none: 'text-muted-foreground',
  warn: 'font-medium text-amber-700 dark:text-amber-300', bad: 'font-medium text-red-700 dark:text-red-300',
};

function RenameDialog({ account, open, onOpenChange, onDone }: { account: ClaudeAccount; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [name, setName] = useState(account.name);
  const a = useAsync();
  const { setError } = a;
  useEffect(() => { if (open) { setName(account.name); setError(''); } }, [open, account.name, setError]);
  const submit = () => a.run(async () => {
    await api('PATCH', `/api/claude/accounts/${account.id}`, { name: name.trim() });
    toast.success('Saved');
    onOpenChange(false); onDone();
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <DialogHeader><DialogTitle>Rename account</DialogTitle><DialogDescription>The name is only shown here and in the project settings.</DialogDescription></DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`rename-${account.id}`}>Account name</Label>
            <Input id={`rename-${account.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />
          </div>
          <ErrorNote>{a.error}</ErrorNote>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <AsyncButton type="submit" disabled={!name.trim() || name.trim() === account.name} busy={a.busy} busyLabel="Saving…">Save</AsyncButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenewDialog({ account, open, onOpenChange, onDone }: { account: ClaudeAccount; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renew “{account.name}”</DialogTitle>
          <DialogDescription>{account.kind === 'oauth' ? 'Sign in again to get a fresh token for this account.' : 'Paste a new API key to replace the current one.'}</DialogDescription>
        </DialogHeader>
        <ClaudeConnect accountId={account.id} kind={account.kind} onCancel={() => onOpenChange(false)} onDone={() => { toast.success('Saved'); onOpenChange(false); onDone(); }} />
      </DialogContent>
    </Dialog>
  );
}

/** One Claude account: type, dates, usage and its (non destructive) actions. Deleting lives in the danger zone. */
export function ClaudeAccountCard({ account: a, admin, onChange }: { account: ClaudeAccount; admin: boolean; onChange: () => void }) {
  const [rename, setRename] = useState(false);
  const [renew, setRenew] = useState(false);
  const exp = claudeExpiry(a);
  const Icon = a.kind === 'oauth' ? UserRound : KeyRound;
  return (
    <Card className="py-4">
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="min-w-0 truncate font-medium">{a.name}</h3>
          <Badge variant="outline">{a.kind === 'oauth' ? 'Subscription' : 'API key'}</Badge>
          {a.isDefault && <Badge><Star className="size-3" aria-hidden="true" />Default</Badge>}
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <div className="flex gap-1.5"><dt>Connected</dt><dd>{new Date(a.connectedAt).toLocaleDateString()}</dd></div>
          <div className={cn('flex items-center gap-1.5', TONE[exp.tone])}><CalendarClock className="size-3.5" aria-hidden="true" /><dd>{exp.label}</dd></div>
          <div className="flex gap-1.5"><dt>Used by</dt><dd>{a.projects === 0 ? 'no project' : `${a.projects} project${a.projects > 1 ? 's' : ''}`}</dd></div>
        </dl>
        {admin && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => setRename(true)}>Rename</Button>
            <Button variant={exp.tone === 'bad' || exp.tone === 'warn' ? 'default' : 'outline'} className="h-11 sm:h-9" onClick={() => setRenew(true)}>Renew</Button>
            {!a.isDefault && (
              <AsyncButton variant="outline" className="h-11 sm:h-9" busyLabel="Saving…" onClick={async () => {
                try { await api('PATCH', `/api/claude/accounts/${a.id}`, { isDefault: true }); toast.success('Saved'); onChange(); } catch (e) { toast.error((e as Error).message); }
              }}>Set as default</AsyncButton>
            )}
          </div>
        )}
      </CardContent>
      <RenameDialog account={a} open={rename} onOpenChange={setRename} onDone={onChange} />
      <RenewDialog account={a} open={renew} onOpenChange={setRenew} onDone={onChange} />
    </Card>
  );
}
