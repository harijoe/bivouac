import { useState } from 'react';
import { toast } from 'sonner';
import { api, type ProjectWithTotals, type Session, type TaskView } from '@/api';
import { aliasError, aliasHost, aliasUrl, MAX_PUBLIC_PATHS, parsePaths, pathsError } from '@/lib/project-env';
import { useAsync, useLoad } from '@/lib/hooks';
import { Link } from '@/lib/router';
import { AsyncButton } from './async-button';
import { CopyField, ErrorNote, Note, StatusBadge } from './misc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

const NONE = '__none__';

/** Admin form: alias name and public paths. */
function AliasForm({ p, session, onChange }: { p: ProjectWithTotals; session: Session; onChange: () => void }) {
  const [alias, setAlias] = useState(p.alias ?? '');
  const [paths, setPaths] = useState(p.aliasPublicPaths.join('\n'));
  const a = useAsync();
  const name = alias.trim();
  const parsed = parsePaths(paths);
  const nameErr = aliasError(name);
  const pErr = pathsError(parsed);
  const dirty = name !== (p.alias ?? '') || parsed.join('\n') !== p.aliasPublicPaths.join('\n');
  const save = () => a.run(async () => {
    await api('PUT', `/api/projects/${p.id}/alias`, { alias: name || null, publicPaths: parsed });
    toast.success('Saved');
    onChange();
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="space-y-1.5">
        <Label htmlFor={`alias-${p.id}`}>Alias name</Label>
        <Input id={`alias-${p.id}`} value={alias} onChange={(e) => setAlias(e.target.value.toLowerCase())} placeholder="app" maxLength={40}
          autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={!!nameErr} aria-describedby={`alias-h-${p.id}`} className="font-mono sm:max-w-xs" />
        <p id={`alias-h-${p.id}`} className={nameErr ? 'text-sm text-red-700 dark:text-red-300' : 'text-sm text-muted-foreground'}>
          {nameErr || (name ? <>Address: <span className="break-all font-mono text-foreground">{aliasHost(name, session.domain)}</span></> : 'Lowercase letters, digits and dashes, 1 to 30 characters. Empty removes the alias.')}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`paths-${p.id}`}>Public paths</Label>
        <Textarea id={`paths-${p.id}`} value={paths} onChange={(e) => setPaths(e.target.value)} rows={4} placeholder={'/api/webhooks/\n/auth/callback'} spellCheck={false}
          aria-invalid={!!pErr} aria-describedby={`paths-h-${p.id}`} className="font-mono text-sm" />
        <p id={`paths-h-${p.id}`} className={pErr ? 'text-sm text-red-700 dark:text-red-300' : 'text-sm text-muted-foreground'}>
          {pErr || `One path per line, at most ${MAX_PUBLIC_PATHS}. These paths skip the access check so that third-party webhooks and OAuth callbacks can reach the app; everything else stays private. End with / for a prefix (/api/webhooks/ covers everything below it).`}
        </p>
        {parsed.length > 0 && !pErr && (
          <Note tone="warn">Anything under {parsed.length > 1 ? 'these paths' : 'this path'} is public: anyone on the internet can call it without signing in.</Note>
        )}
      </div>
      <ErrorNote>{a.error}</ErrorNote>
      <AsyncButton type="submit" className="h-11 sm:h-9" busy={a.busy} busyLabel="Saving…" disabled={!dirty || !!nameErr || !!pErr}>Save</AsyncButton>
    </form>
  );
}

/** Any user: which task the alias points at. */
function AliasTarget({ p, session, onChange }: { p: ProjectWithTotals; session: Session; onChange: () => void }) {
  const tasks = useLoad(() => api<TaskView[]>('GET', `/api/tasks?project=${p.id}`), [p.id, p.aliasTaskId]);
  const [pick, setPick] = useState<string>('');
  const a = useAsync();
  const list = tasks.data;
  const current = list?.find((t) => t.id === p.aliasTaskId) ?? null;
  const url = p.alias ? aliasUrl(p.alias, session.domain, session.baseUrl) : '';
  const move = (task: string | null) => a.run(async () => {
    await api('PUT', `/api/projects/${p.id}/alias`, { task });
    toast.success(task ? `${url} now opens ${task}` : 'Alias detached');
    setPick('');
    onChange();
  });
  if (!p.alias) return <p className="text-sm text-muted-foreground">Set an alias name first (administrators can do it above), then choose the task it opens.</p>;
  const chosen = pick || (current?.name ?? '');
  return (
    <div className="space-y-3">
      <CopyField label="Alias address" value={url} />
      <p className="text-sm">
        {p.aliasTaskId === null ? <span className="text-muted-foreground">Not attached to any task yet.</span>
          : current ? <>Opens the preview of <Link to={`/projects/${encodeURIComponent(p.name)}/${encodeURIComponent(current.name)}`} className="font-medium underline underline-offset-4">{current.name}</Link>.</>
          : <span className="text-muted-foreground">Attached to a task that is no longer listed.</span>}
      </p>
      {tasks.error && <ErrorNote>{tasks.error}</ErrorNote>}
      {!list && !tasks.error && <Skeleton className="h-11 w-full sm:h-9 sm:w-80" aria-label="Loading tasks" />}
      {list && list.length === 0 && <p className="text-sm text-muted-foreground">This project has no task yet: create one to point the alias at it.</p>}
      {list && list.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 space-y-1.5 sm:w-80">
            <Label htmlFor={`target-${p.id}`}>Task that opens at the alias</Label>
            <Select value={chosen || NONE} onValueChange={(v) => setPick(v === NONE ? '' : v)} disabled={a.busy}>
              <SelectTrigger id={`target-${p.id}`} className="h-11 w-full sm:h-9"><SelectValue placeholder="Choose a task" /></SelectTrigger>
              <SelectContent>
                {!chosen && <SelectItem value={NONE} disabled>Choose a task</SelectItem>}
                {list.map((t) => <SelectItem key={t.id} value={t.name}><span className="truncate">{t.name}</span><StatusBadge status={t.status} className="ml-2" /></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <AsyncButton className="h-11 sm:h-9" disabled={!pick || pick === current?.name} busyLabel="Moving…" onClick={() => move(pick)}>Point alias here</AsyncButton>
          <AsyncButton variant="outline" className="h-11 sm:h-9" disabled={p.aliasTaskId === null} busyLabel="Detaching…" onClick={() => move(null)}>Detach</AsyncButton>
        </div>
      )}
      <ErrorNote>{a.error}</ErrorNote>
    </div>
  );
}

export function ProjectAlias({ p, session, admin, onChange }: { p: ProjectWithTotals; session: Session; admin: boolean; onChange: () => void }) {
  return (
    <section className="space-y-4 p-4" aria-labelledby={`alias-title-${p.id}`}>
      <div className="max-w-2xl space-y-1">
        <h3 id={`alias-title-${p.id}`} className="font-medium">Preview alias <span className="font-normal text-muted-foreground">· {p.name}</span></h3>
        <p className="text-sm text-muted-foreground">A stable address such as https://app.{session.domain} that always opens the preview of one chosen task. Use it for the OAuth redirect URIs and webhooks of the app under test; moving it to another task takes it away from the previous one.</p>
      </div>
      {admin && <AliasForm key={`${p.alias}|${p.aliasPublicPaths.join()}`} p={p} session={session} onChange={onChange} />}
      <AliasTarget p={p} session={session} onChange={onChange} />
    </section>
  );
}

/** Read-only summary for the project page (nothing when the project has no alias). */
export function AliasSummary({ p, session, taskName }: { p: ProjectWithTotals; session: Session; taskName: string | null }) {
  if (!p.alias) return null;
  const url = aliasUrl(p.alias, session.domain, session.baseUrl);
  return (
    <section className="space-y-2 rounded-lg border p-4" aria-labelledby="alias-summary">
      <h2 id="alias-summary" className="text-sm font-medium">Preview alias</h2>
      <p className="text-sm text-muted-foreground">
        {taskName ? <>Opens the preview of <Link to={`/projects/${encodeURIComponent(p.name)}/${encodeURIComponent(taskName)}`} className="font-medium text-foreground underline underline-offset-4">{taskName}</Link>.</> : 'Not attached to any task.'}
        {p.aliasPublicPaths.length > 0 && <> {p.aliasPublicPaths.length} public path{p.aliasPublicPaths.length > 1 ? 's' : ''} skip the access check.</>}
      </p>
      <CopyField value={url} label="Alias address" />
    </section>
  );
}
