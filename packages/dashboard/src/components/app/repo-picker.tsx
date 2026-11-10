import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { ago, api } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ErrorNote, Note } from '@/components/app/misc';
import { filterRepos, type Repo } from '@/components/app/repo-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync } from '@/lib/hooks';

export const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const MAX_SHOWN = 100;

/** Adds one repository with a fine-grained token (e.g. a repository of an organisation). The token is checked on save. */
export function TokenRepoForm({ onAdded }: { onAdded: () => void }) {
  const [repoUrl, setRepoUrl] = useState('');
  const [token, setToken] = useState('');
  const a = useAsync();
  const submit = () => a.run(async () => {
    await api('POST', '/api/projects', { repoUrl: repoUrl.trim(), githubToken: token.trim() });
    setRepoUrl(''); setToken('');
    toast.success('Repository added');
    onAdded();
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li><a className="inline-flex items-center gap-1 font-medium underline underline-offset-4" href={TOKEN_URL} target="_blank" rel="noreferrer">Create a fine-grained token on GitHub<ExternalLink className="size-3.5" aria-hidden="true" /></a>. Under <b>Repository access</b>, choose <b>Only select repositories</b> and pick just this repository.</li>
        <li>Under <b>Repository permissions</b>, set exactly these (the rest stays on “No access”):
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li><b>Contents</b>: Read and write (clone, and push the task branch)</li>
            <li><b>Pull requests</b>: Read and write (open the pull request)</li>
            <li><b>Metadata</b>: Read (added automatically)</li>
          </ul>
          <span className="mt-1 block text-muted-foreground">For an organisation’s repository, the organisation’s owners may need to approve the token first.</span>
        </li>
        <li>Paste the repository address and the token below. bivouac checks that the token works before saving it.</li>
      </ol>
      <div className="space-y-1.5">
        <Label htmlFor="token-repo-url">Repository address</Label>
        <Input id="token-repo-url" placeholder="https://github.com/your-org/your-app" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} autoCapitalize="none" spellCheck={false} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="token-repo-token">Fine-grained token</Label>
        <Input id="token-repo-token" type="password" autoComplete="off" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" />
      </div>
      <ErrorNote>{a.error}</ErrorNote>
      <AsyncButton type="submit" size="lg" className="h-11 sm:h-9" disabled={!repoUrl.trim() || !token.trim()} busy={a.busy} busyLabel="Checking the token…">Add this repository</AsyncButton>
    </form>
  );
}

/** The always visible way to add a repository the GitHub app cannot reach. */
function TokenAction({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button variant="outline" className="h-11 sm:h-9" aria-expanded={open} aria-controls="token-repo-panel" onClick={() => setOpen(!open)}><KeyRound />{open ? 'Hide the token form' : 'Add a repository with a token'}</Button>
      {open && <div id="token-repo-panel" className="rounded-lg border p-4"><TokenRepoForm onAdded={() => { setOpen(false); onAdded(); }} /></div>}
    </div>
  );
}

interface ReposResponse { configured: boolean; repos: Repo[]; installUrl: string | null }

/** Search selector over the repositories shared with the GitHub app, plus the token fallback. */
export function RepoPicker({ onAdded }: { onAdded: () => void }) {
  const [data, setData] = useState<ReposResponse | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const a = useAsync();
  const load = useCallback(() => { api<ReposResponse>('GET', '/api/github/repos').then((d) => { setData(d); setError(''); }).catch((e) => setError((e as Error).message)); }, []);
  useEffect(load, [load]);

  if (!data) {
    return error
      ? <div className="space-y-3"><ErrorNote>{error}</ErrorNote><Button variant="outline" onClick={load}>Try again</Button></div>
      : <div className="space-y-2" aria-busy="true" aria-label="Loading repositories"><Skeleton className="h-10 w-full" /><Skeleton className="h-40 w-full" /></div>;
  }
  const shown = filterRepos(data.repos, query);
  const add = (r: Repo) => {
    setAdding(r.fullName);
    void a.run(async () => {
      await api('POST', '/api/projects', { fullName: r.fullName });
      toast.success(`${r.fullName} added`);
      load(); onAdded();
    }).finally(() => setAdding(null));
  };
  const refresh = () => { load(); onAdded(); };

  return (
    <div className="space-y-4">
      {data.repos.length === 0 ? (
        <Note title="No repository is shared with bivouac yet">{data.installUrl ? 'Choose the repositories bivouac may use on GitHub, then come back and reload this list.' : 'Add one with a token below.'}</Note>
      ) : (
        <Command shouldFilter={false} className="rounded-lg border">
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search by owner or name…" aria-label="Search repositories" />
          <CommandList className="max-h-72">
            <CommandEmpty>No repository matches “{query}”.</CommandEmpty>
            <CommandGroup>
              {shown.slice(0, MAX_SHOWN).map((r) => (
                <CommandItem key={r.fullName} value={r.fullName} disabled={r.added || adding !== null} onSelect={() => add(r)} className="min-h-11 gap-2 sm:min-h-0">
                  <span className="min-w-0 flex-1 truncate"><span className="text-muted-foreground">{r.owner}/</span><b className="font-medium">{r.fullName.slice(r.owner.length + 1)}</b></span>
                  {r.private && <Badge variant="outline" className="gap-1"><Lock className="size-3" aria-hidden="true" />private</Badge>}
                  {r.pushedAt && <span className="hidden text-xs text-muted-foreground sm:inline">{ago(r.pushedAt)}</span>}
                  {r.added ? <Badge variant="secondary"><Check className="size-3" aria-hidden="true" />Added</Badge>
                    : adding === r.fullName ? <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />Adding…</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
            {shown.length > MAX_SHOWN && <p className="px-3 pb-2 text-xs text-muted-foreground">Showing the {MAX_SHOWN} most recent of {shown.length}. Keep typing to narrow the list.</p>}
          </CommandList>
        </Command>
      )}
      <ErrorNote>{a.error}</ErrorNote>
      <div className="flex flex-wrap gap-2">
        {data.installUrl && <Button asChild variant="secondary" className="h-11 sm:h-9"><a href={data.installUrl}><ExternalLink />Choose repositories on GitHub</a></Button>}
      </div>
      <TokenAction onAdded={refresh} />
    </div>
  );
}
