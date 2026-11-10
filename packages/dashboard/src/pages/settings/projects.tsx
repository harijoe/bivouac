import { useState } from 'react';
import { ExternalLink, FolderGit2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ClaudeAccount, type ProjectWithTotals } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { ErrorNote, EmptyState, Note } from '@/components/app/misc';
import { RepoPicker, TokenRepoForm } from '@/components/app/repo-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync, useLoad } from '@/lib/hooks';
import type { SectionProps } from './types';

const DEFAULT = 'default';

function AddRepository({ s, onAdded }: { s: SectionProps['s']; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button className="h-11 sm:h-9"><Plus />Add a repository</Button></DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a repository</DialogTitle>
          <DialogDescription>Pick one of the repositories shared with bivouac, or add one with a token.</DialogDescription>
        </DialogHeader>
        {s.github.configured
          ? <RepoPicker onAdded={onAdded} />
          : <TokenRepoForm onAdded={() => { setOpen(false); onAdded(); }} />}
      </DialogContent>
    </Dialog>
  );
}

function ProjectRow({ p, accounts, admin, onChange }: { p: ProjectWithTotals; accounts: ClaudeAccount[]; admin: boolean; onChange: () => void }) {
  const a = useAsync();
  const repo = p.githubRepo ?? p.repoUrl;
  const href = p.githubRepo ? `https://github.com/${p.githubRepo}` : p.repoUrl;
  const value = p.claudeAccountId === null ? DEFAULT : String(p.claudeAccountId);
  const known = p.claudeAccountId === null || accounts.some((x) => x.id === p.claudeAccountId);
  const change = (v: string) => a.run(async () => {
    await api('PATCH', `/api/projects/${p.id}`, { claudeAccountId: v === DEFAULT ? null : Number(v) });
    toast.success('Saved. It applies from the next attempt, without restarting the task.');
    onChange();
  });
  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="truncate font-medium">{p.name}</p>
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"><span className="truncate">{repo}</span><ExternalLink className="size-3 shrink-0" aria-hidden="true" /></a>
        </div>
        <p className="text-sm text-muted-foreground">{p.totals.tasks === 0 ? 'No task yet' : `${p.totals.tasks} task${p.totals.tasks > 1 ? 's' : ''}`}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`acct-${p.id}`} className="text-muted-foreground">Claude account</Label>
        {admin ? (
          <Select value={value} onValueChange={(v) => void change(v)} disabled={a.busy}>
            <SelectTrigger id={`acct-${p.id}`} className="h-11 w-full sm:h-9 sm:w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>Default account</SelectItem>
              {accounts.map((x) => <SelectItem key={x.id} value={String(x.id)}>{x.name}</SelectItem>)}
              {!known && <SelectItem value={value}>{p.claudeAccountName ?? 'Unknown account'}</SelectItem>}
            </SelectContent>
          </Select>
        ) : <p id={`acct-${p.id}`} className="text-sm">{p.claudeAccountName ?? 'Default account'}</p>}
        <ErrorNote>{a.error}</ErrorNote>
      </div>
    </li>
  );
}

function Budgets({ s, reload }: SectionProps) {
  const [it, setIt] = useState(String(s.budgets.maxIterations ?? ''));
  const [cost, setCost] = useState(String(s.budgets.maxCostUsd ?? ''));
  const a = useAsync();
  const save = () => a.run(async () => {
    await api('PUT', '/api/settings/budgets', { maxIterations: it || null, maxCostUsd: cost || null });
    toast.success('Saved');
    reload();
  });
  return (
    <section className="space-y-4" aria-labelledby="limits-title">
      <div className="max-w-2xl space-y-1">
        <h2 id="limits-title" className="text-lg font-semibold">Default limits</h2>
        <p className="text-sm text-muted-foreground">Applied to new tasks unless the project or the request says otherwise. Leave empty for the built-in defaults (10 attempts, $20). The dollar limit is a safeguard on consumption: with a Claude subscription the amount is the estimated API equivalent reported by Claude, not money you spend.</p>
      </div>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="limit-attempts">Attempts per task</Label>
            <Input id="limit-attempts" inputMode="numeric" value={it} onChange={(e) => setIt(e.target.value)} placeholder="10" disabled={!s.admin} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="limit-cost">Maximum per task (USD, estimated API equivalent)</Label>
            <Input id="limit-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="20" disabled={!s.admin} />
          </div>
        </div>
        <ErrorNote>{a.error}</ErrorNote>
        {s.admin && <AsyncButton type="submit" size="lg" className="h-11 sm:h-9" busy={a.busy} busyLabel="Saving…">Save</AsyncButton>}
      </form>
    </section>
  );
}

export function ProjectsSection(props: SectionProps) {
  const { s } = props;
  const projects = useLoad(() => api<ProjectWithTotals[]>('GET', '/api/projects'));
  const accounts = useLoad(() => api<ClaudeAccount[]>('GET', '/api/claude/accounts'));
  const list = projects.data;
  const refresh = () => { projects.reload(); accounts.reload(); };
  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="projects-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="projects-title" className="text-lg font-semibold">Projects</h2>
          {s.admin && <AddRepository s={s} onAdded={refresh} />}
        </div>
        {projects.error && <Note tone="error" title="The projects could not be loaded">{projects.error} <Button variant="link" className="h-auto p-0 text-current underline" onClick={projects.reload}>Try again</Button></Note>}
        {!list && !projects.error && <div className="space-y-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>}
        {list && list.length === 0 && (
          <EmptyState icon={FolderGit2} title="No project yet" action={s.admin ? <AddRepository s={s} onAdded={refresh} /> : undefined}>
            {s.admin ? 'Add a repository to start giving tasks to Claude.' : 'Ask an administrator to add a repository.'}
          </EmptyState>
        )}
        {list && list.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {list.map((p) => <ProjectRow key={p.id} p={p} accounts={accounts.data ?? []} admin={s.admin} onChange={refresh} />)}
          </ul>
        )}
      </section>

      <Budgets {...props} />

      {s.admin && list && list.length > 0 && (
        <section className="space-y-3 rounded-lg border border-red-500/40 p-4" aria-labelledby="projects-danger">
          <div>
            <h3 id="projects-danger" className="font-medium text-red-700 dark:text-red-300">Danger zone</h3>
            <p className="text-sm text-muted-foreground">Removing a project only forgets it in bivouac. Your repository on GitHub is not touched. A project with tasks cannot be removed: delete or archive its tasks first.</p>
          </div>
          <ul className="divide-y">
            {list.map((p) => (
              <li key={p.id} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate text-sm font-medium">{p.name}</span>
                <ConfirmDialog
                  trigger={<Button variant="outline" className="h-11 border-red-500/40 text-red-700 hover:text-red-700 sm:h-9 dark:text-red-300">Remove</Button>}
                  title={`Remove ${p.name}?`} confirmLabel="Remove project" busyLabel="Removing…"
                  description={<>{p.name} is removed from bivouac. Your repository on GitHub is not touched.{p.totals.tasks > 0 && ` It has ${p.totals.tasks} task${p.totals.tasks > 1 ? 's' : ''}: delete or archive them first, or the removal will be refused.`}</>}
                  onConfirm={async () => { await api('DELETE', `/api/projects/${p.id}`); toast.success('Project removed'); refresh(); }}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
