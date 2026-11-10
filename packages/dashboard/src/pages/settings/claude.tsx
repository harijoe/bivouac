import { useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ClaudeAccount } from '@/api';
import { ClaudeAccountCard } from '@/components/app/claude-account-card';
import { ClaudeConnect, ClaudeHelp } from '@/components/app/claude-connect';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { EmptyState, Note } from '@/components/app/misc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useLoad } from '@/lib/hooks';
import type { SectionProps } from './types';

function AddAccount({ first, onAdded }: { first: boolean; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button className="h-11 sm:h-9"><Plus />Add an account</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a Claude account</DialogTitle>
          <DialogDescription>Give it a name, then choose how to sign in.</DialogDescription>
        </DialogHeader>
        <ClaudeConnect defaultName={first ? 'Default' : ''} onCancel={() => setOpen(false)} onDone={() => { toast.success('Account added'); setOpen(false); onAdded(); }} />
      </DialogContent>
    </Dialog>
  );
}

export function ClaudeSection({ s, reload }: SectionProps) {
  const list = useLoad(() => api<ClaudeAccount[]>('GET', '/api/claude/accounts'));
  const refresh = () => { list.reload(); reload(); };
  const accounts = list.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl space-y-2">
          <h2 className="text-lg font-semibold">Claude accounts</h2>
          <ClaudeHelp />
        </div>
        {s.admin && accounts && <AddAccount first={accounts.length === 0} onAdded={refresh} />}
      </div>

      {list.error && <Note tone="error" title="The accounts could not be loaded">{list.error} <Button variant="link" className="h-auto p-0 text-current underline" onClick={list.reload}>Try again</Button></Note>}
      {!accounts && !list.error && <div className="space-y-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>}
      {accounts && accounts.length === 0 && (
        <EmptyState icon={Sparkles} title="No Claude account yet" action={s.admin ? <AddAccount first onAdded={refresh} /> : undefined}>
          {s.admin ? 'Connect your Claude subscription or an API key so tasks can run.' : 'Ask an administrator to connect Claude.'}
        </EmptyState>
      )}
      {accounts?.some((a) => a.expired) && <Note tone="error" title="A Claude token expired">Tasks using an expired account fail. Click Renew on the account to let them run again.</Note>}
      {accounts && accounts.length > 0 && (
        <div className="space-y-3">
          {accounts.map((a) => <ClaudeAccountCard key={a.id} account={a} admin={s.admin} onChange={refresh} />)}
          {!s.admin && <p className="text-sm text-muted-foreground">Ask an administrator to manage these accounts.</p>}
        </div>
      )}

      {s.admin && accounts && accounts.length > 0 && (
        <section className="space-y-3 rounded-lg border border-red-500/40 p-4" aria-labelledby="claude-danger">
          <div>
            <h3 id="claude-danger" className="font-medium text-red-700 dark:text-red-300">Danger zone</h3>
            <p className="text-sm text-muted-foreground">Deleting an account cannot be undone. Projects that used it fall back to the default account. The default account can only be deleted when it is the last one: set another as default first.</p>
          </div>
          <ul className="divide-y">
            {accounts.map((a) => (
              <li key={a.id} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate text-sm font-medium">{a.name}{a.isDefault && <span className="ml-2 font-normal text-muted-foreground">default</span>}</span>
                <ConfirmDialog
                  trigger={<Button variant="outline" className="h-11 border-red-500/40 text-red-700 hover:text-red-700 sm:h-9 dark:text-red-300">Delete</Button>}
                  title={`Delete “${a.name}”?`} confirmLabel="Delete account" busyLabel="Deleting…"
                  description={<>The stored credentials are erased. {a.projects > 0 ? `${a.projects} project${a.projects > 1 ? 's' : ''} using it will fall back to the default account.` : 'No project uses it explicitly.'} Running tasks that rely on it will fail.</>}
                  onConfirm={async () => { await api('DELETE', `/api/claude/accounts/${a.id}`); toast.success('Account deleted'); refresh(); }}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
