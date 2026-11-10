import { useState } from 'react';
import { ago, api } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { ErrorNote, Note } from '@/components/app/misc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAsync } from '@/lib/hooks';
import type { SectionProps } from './types';

type Kind = 'user' | 'org' | 'team';
const KIND_LABEL: Record<string, string> = { user: 'person', org: 'organisation', team: 'team' };
const PLACEHOLDER: Record<Kind, string> = { user: 'GitHub username', org: 'organisation name', team: 'organisation/team-name' };

interface AuditRow { id: number; ts: string; actor: string; action: string; detail: { task?: string; client?: string } | null }

function AllowForm({ reload }: { reload: () => void }) {
  const [kind, setKind] = useState<Kind>('user');
  const [value, setValue] = useState('');
  const a = useAsync();
  return (
    <form className="space-y-3 border-t pt-4" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('POST', '/api/settings/allowlist', { kind, value: value.trim() }); setValue(''); reload(); }); }}>
      <p className="text-sm font-medium">Allow someone new</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="sm:w-44">
          <Label htmlFor="allow-kind" className="sr-only">Type</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger id="allow-kind" className="h-11 w-full sm:h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="user">Person</SelectItem>
              <SelectItem value="org">Organisation</SelectItem>
              <SelectItem value="team">Team</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1">
          <Label htmlFor="allow-value" className="sr-only">{PLACEHOLDER[kind]}</Label>
          <Input id="allow-value" className="h-11 sm:h-9" placeholder={PLACEHOLDER[kind]} value={value} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setValue(e.target.value)} />
        </div>
        <AsyncButton type="submit" className="h-11 sm:h-9" disabled={!value.trim()} busy={a.busy} busyLabel="Adding…">Allow</AsyncButton>
      </div>
      <ErrorNote>{a.error}</ErrorNote>
    </form>
  );
}

function Activity() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const a = useAsync();
  return (
    <Card>
      <CardHeader><CardTitle>Recent activity</CardTitle><CardDescription>Who did what on this bivouac.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <ErrorNote>{a.error}</ErrorNote>
        {rows === null ? (
          <AsyncButton variant="outline" className="h-11 sm:h-9" busyLabel="Loading the activity…" busy={a.busy} onClick={() => a.run(async () => setRows(await api<AuditRow[]>('GET', '/api/settings/audit?limit=60')))}>Show activity</AsyncButton>
        ) : rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded yet.</p> : (
          <ul className="divide-y text-sm">
            {rows.map((r) => (
              <li key={r.id} className="py-2">
                <b>{r.actor}</b> {r.action.replace(/_/g, ' ')}{r.detail?.task ? ` · ${r.detail.task}` : r.detail?.client ? ` · ${r.detail.client}` : ''}
                <span className="block text-muted-foreground">{ago(r.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function AccessSection({ s, reload }: SectionProps) {
  const heading = (
    <div>
      <h2 className="text-lg font-semibold">Who can sign in</h2>
      <p className="text-sm text-muted-foreground">People are identified by their permanent GitHub id. Administrators can always sign in.</p>
    </div>
  );
  if (!s.admin) return <div className="space-y-6">{heading}<Note>Only an administrator can see and change who has access.</Note></div>;

  return (
    <div className="space-y-6">
      {heading}
      <Card>
        <CardHeader><CardTitle>Allowed</CardTitle><CardDescription>Anyone matching one of these can sign in with GitHub.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {s.allowlist.length === 0 ? <p className="text-sm text-muted-foreground">Nobody is allowed yet besides the administrators. Add a person, an organisation or a team below.</p> : (
            <ul className="divide-y">
              {s.allowlist.map((e) => (
                <li key={e.id} className="flex min-h-11 items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 items-center gap-2"><b className="truncate">{e.label ?? e.value}</b><Badge variant="secondary">{KIND_LABEL[e.kind] ?? e.kind}</Badge></span>
                  <ConfirmDialog
                    trigger={<Button variant="outline" size="sm" className="h-11 sm:h-8">Remove</Button>}
                    title={`Remove ${e.label ?? e.value}?`}
                    description={e.kind === 'user' ? 'They will be signed out and their chat apps disconnected. They can no longer sign in.' : 'People who only had access through this entry can no longer sign in.'}
                    confirmLabel="Remove" busyLabel="Removing…"
                    onConfirm={async () => { await api('DELETE', `/api/settings/allowlist/${e.id}`); reload(); }}
                  />
                </li>
              ))}
            </ul>
          )}
          <AllowForm reload={reload} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Signed-in users</CardTitle><CardDescription>People who have signed in at least once.</CardDescription></CardHeader>
        <CardContent>
          {s.users.length === 0 ? <p className="text-sm text-muted-foreground">Nobody has signed in yet.</p> : (
            <ul className="divide-y">
              {s.users.map((u) => (
                <li key={u.githubId} className="flex min-h-11 items-center justify-between gap-2 py-2">
                  <b className="truncate">{u.login}</b><Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role === 'admin' ? 'administrator' : 'member'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Activity />
    </div>
  );
}
