import { useRef, useState } from 'react';
import { KeyRound, ServerCog, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ago, api, type ProjectWithTotals } from '@/api';
import { secretNameError, shortFingerprint } from '@/lib/project-env';
import { useAsync, useLoad } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { AsyncButton } from './async-button';
import { ConfirmDialog } from './confirm-dialog';
import { ErrorNote, Note } from './misc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

interface McpSpec { command?: string; args?: string[]; url?: string; secrets?: string[] }
interface McpData {
  secrets: { name: string; updatedAt: string }[];
  servers: { name: string; fingerprint: string; spec: McpSpec; approved: boolean; seenAt: string }[];
}

function SecretForm({ projectId, name, setName, onSaved, existing }: { projectId: number; name: string; setName: (v: string) => void; onSaved: () => void; existing: string[] }) {
  const [value, setValue] = useState('');
  const a = useAsync();
  const nameInput = useRef<HTMLInputElement>(null);
  const err = secretNameError(name);
  const replacing = existing.includes(name);
  const save = () => a.run(async () => {
    await api('PUT', `/api/projects/${projectId}/mcp/secrets/${encodeURIComponent(name)}`, { value: value.trim() });
    toast.success(replacing ? `${name} replaced` : `${name} saved`);
    setValue(''); setName('');
    onSaved();
  });
  return (
    <form className="space-y-3 rounded-lg border p-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`secret-name-${projectId}`}>Secret name</Label>
          <Input ref={nameInput} id={`secret-name-${projectId}`} value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="LINEAR_API_KEY" maxLength={63}
            autoCapitalize="characters" autoCorrect="off" autoComplete="off" spellCheck={false} aria-invalid={!!err} aria-describedby={`secret-name-h-${projectId}`} className="h-11 font-mono sm:h-9" />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`secret-value-${projectId}`}>Value</Label>
          <Input id={`secret-value-${projectId}`} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={4000}
            placeholder={replacing ? 'New value' : 'Secret value'} className="h-11 sm:h-9" />
        </div>
      </div>
      <p id={`secret-name-h-${projectId}`} className={cn('text-sm', err ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground')}>
        {err || (replacing ? `${name} already exists: saving replaces its value.` : 'Capital letters, digits and underscores. The value is stored encrypted and is never shown again.')}
      </p>
      <ErrorNote>{a.error}</ErrorNote>
      <AsyncButton type="submit" className="h-11 sm:h-9" busy={a.busy} busyLabel="Saving…" disabled={!name || !!err || !value.trim()}>{replacing ? 'Replace secret' : 'Save secret'}</AsyncButton>
    </form>
  );
}

function Server({ projectId, srv, known, onChange }: { projectId: number; srv: McpData['servers'][number]; known: Set<string>; onChange: () => void }) {
  const a = useAsync();
  const { spec } = srv;
  const secrets = spec.secrets ?? [];
  const missing = secrets.filter((s) => !known.has(s));
  const act = (action: 'approve' | 'revoke') => a.run(async () => {
    await api('POST', `/api/projects/${projectId}/mcp/servers/${encodeURIComponent(srv.fingerprint)}/${action}`, {});
    toast.success(action === 'approve' ? `${srv.name} approved` : `${srv.name} revoked`);
    onChange();
  });
  return (
    <li className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-all font-mono text-sm font-medium">{srv.name}</span>
        <Badge variant="outline" className={cn('font-medium', srv.approved ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300')}>
          {srv.approved ? 'Approved' : 'Not approved'}
        </Badge>
      </div>
      <dl className="space-y-1 text-sm">
        <div className="grid gap-0.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-muted-foreground">{spec.url ? 'URL' : 'Command'}</dt>
          <dd className="min-w-0 break-all font-mono text-xs">{spec.url ?? [spec.command, ...(spec.args ?? [])].join(' ')}</dd>
        </div>
        <div className="grid gap-0.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-muted-foreground">Asks for</dt>
          <dd className="flex min-w-0 flex-wrap gap-1">{secrets.map((s) => <code key={s} className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{s}</code>)}</dd>
        </div>
        <div className="grid gap-0.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-muted-foreground">Definition</dt>
          <dd className="text-xs text-muted-foreground">fingerprint <span className="font-mono">{shortFingerprint(srv.fingerprint)}</span> · seen {ago(srv.seenAt)}</dd>
        </div>
      </dl>
      {missing.length > 0 && <p className="text-sm text-amber-700 dark:text-amber-300">Missing secret{missing.length > 1 ? 's' : ''}: {missing.join(', ')}. The server is left out until {missing.length > 1 ? 'they are' : 'it is'} set.</p>}
      <ErrorNote>{a.error}</ErrorNote>
      {srv.approved
        ? <AsyncButton variant="outline" className="h-11 sm:h-9" busy={a.busy} busyLabel="Revoking…" onClick={() => act('revoke')}>Revoke</AsyncButton>
        : <AsyncButton className="h-11 sm:h-9" busy={a.busy} busyLabel="Approving…" onClick={() => act('approve')}>Approve</AsyncButton>}
    </li>
  );
}

export function ProjectMcp({ p }: { p: ProjectWithTotals }) {
  const q = useLoad(() => api<McpData>('GET', `/api/projects/${p.id}/mcp`), [p.id]);
  const [name, setName] = useState('');
  const d = q.data;
  const names = d?.secrets.map((s) => s.name) ?? [];
  return (
    <section className="space-y-4 p-4" aria-labelledby={`mcp-title-${p.id}`}>
      <div className="max-w-2xl space-y-1">
        <h3 id={`mcp-title-${p.id}`} className="font-medium">MCP servers and secrets <span className="font-normal text-muted-foreground">· {p.name}</span></h3>
        <p className="text-sm text-muted-foreground">Secrets are passed to the MCP servers that ask for them in bivouac.yml. Values are write-only: they are stored encrypted and never displayed again.</p>
      </div>
      {q.error && <Note tone="error" title="MCP settings could not be loaded">{q.error} <Button variant="link" className="h-auto p-0 text-current underline" onClick={q.reload}>Try again</Button></Note>}
      {!d && !q.error && <div className="space-y-2" aria-busy="true" aria-label="Loading MCP settings"><Skeleton className="h-12 w-full" /><Skeleton className="h-24 w-full" /></div>}
      {d && (
        <>
          <div className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-sm font-medium"><KeyRound className="size-4" aria-hidden="true" />Secrets</h4>
            {d.secrets.length === 0
              ? <p className="text-sm text-muted-foreground">No secret yet.</p>
              : (
                <ul className="divide-y rounded-lg border" aria-label="Secrets">
                  {d.secrets.map((s) => (
                    <li key={s.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
                      <div className="min-w-0">
                        <p className="break-all font-mono text-sm">{s.name}</p>
                        <p className="text-xs text-muted-foreground">updated {ago(s.updatedAt)}</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <Button variant="ghost" size="sm" className="h-11 sm:h-8" aria-label={`Replace ${s.name}`} onClick={() => { setName(s.name); document.getElementById(`secret-value-${p.id}`)?.focus(); }}>Replace</Button>
                        <ConfirmDialog
                          trigger={<Button variant="ghost" size="sm" className="h-11 sm:h-8" aria-label={`Delete ${s.name}`}><Trash2 />Delete</Button>}
                          title={`Delete ${s.name}?`} confirmLabel="Delete secret" busyLabel="Deleting…"
                          description="The value is erased. MCP servers that ask for it are left out of the next tasks until you set it again."
                          onConfirm={async () => { await api('DELETE', `/api/projects/${p.id}/mcp/secrets/${encodeURIComponent(s.name)}`); toast.success(`${s.name} deleted`); q.reload(); }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            <SecretForm projectId={p.id} name={name} setName={setName} existing={names} onSaved={q.reload} />
          </div>
          <div className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-sm font-medium"><ServerCog className="size-4" aria-hidden="true" />Servers that use secrets</h4>
            <p className="max-w-2xl text-sm text-muted-foreground">A server receives the secret values of this project. Its definition is read from the repository, which the agent can edit, so you approve exactly what it sends them to. Changing the definition asks for a new approval.</p>
            {d.servers.length === 0
              ? (
                <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  <ServerCog className="size-5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">Servers appear here after a task has read a bivouac.yml with an <code className="font-mono">mcp:</code> section whose server lists <code className="font-mono">secrets:</code>.</span>
                </div>
              )
              : <ul className="divide-y rounded-lg border" aria-label="MCP servers">{d.servers.map((s) => <Server key={`${s.name}-${s.fingerprint}`} projectId={p.id} srv={s} known={new Set(names)} onChange={q.reload} />)}</ul>}
          </div>
        </>
      )}
    </section>
  );
}
