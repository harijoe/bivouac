import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { api, ApiError, type ProjectWithTotals, type Session, type TaskView } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ConnectChatHint } from '@/components/app/connect-chat-card';
import { EmptyState, Note, PageHeader } from '@/components/app/misc';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useLoad } from '@/lib/hooks';
import { Link, navigate } from '@/lib/router';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const Help = ({ id, children }: { id: string; children: React.ReactNode }) => <p id={id} className="text-xs text-muted-foreground">{children}</p>;
const Err = ({ id, children }: { id: string; children?: string }) => (children ? <p id={id} role="alert" className="text-xs text-destructive">{children}</p> : null);

export function NewTaskPage({ project: initial, session }: { project: string | null; session: Session }) {
  const projects = useLoad(() => api<ProjectWithTotals[]>('GET', '/api/projects'));
  const [project, setProject] = useState(initial ?? '');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [successCommand, setSuccessCommand] = useState('');
  const [maxIterations, setMaxIterations] = useState('');
  const [maxCostUsd, setMaxCostUsd] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const list = projects.data;

  useEffect(() => { if (list && !project && list.length === 1) setProject(list[0].name); }, [list, project]);
  useEffect(() => { if (list) promptRef.current?.focus(); }, [!!list]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!project) e.project = 'Choose the project the task belongs to.';
    if (!prompt.trim()) e.prompt = 'Describe what the agent should do.';
    if (name && !NAME_RE.test(name)) e.name = 'Use lowercase letters, digits and dashes only (e.g. dark-mode).';
    if (maxIterations && !(Number.isInteger(Number(maxIterations)) && Number(maxIterations) >= 1)) { e.maxIterations = 'Enter a whole number, 1 or more.'; }
    if (maxCostUsd && !(Number(maxCostUsd) > 0)) e.maxCostUsd = 'Enter an amount in dollars greater than 0.';
    setErrs(e);
    if (Object.keys(e).some((k) => !['project', 'prompt'].includes(k))) setAdvanced(true);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (busy || !validate()) return;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { project, prompt: prompt.trim() };
      if (name) body.name = name;
      if (successCommand.trim()) body.successCommand = successCommand.trim();
      if (maxIterations) body.maxIterations = Number(maxIterations);
      if (maxCostUsd) body.maxCostUsd = Number(maxCostUsd);
      if (baseBranch.trim()) body.baseBranch = baseBranch.trim();
      const t = await api<TaskView>('POST', '/api/tasks', body);
      navigate(`/projects/${encodeURIComponent(project)}/${encodeURIComponent(t.name)}`);
    } catch (e) {
      setError({ message: (e as Error).message, code: e instanceof ApiError ? (e.body.code as string | undefined) : undefined });
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } };

  if (projects.error && !list) return <Note tone="error" title="Could not load the projects">{projects.error}. Reload the page to try again.</Note>;
  if (!list) return <div className="space-y-4" aria-busy="true"><Skeleton className="h-9 w-1/3" /><Skeleton className="h-10 w-full" /><Skeleton className="h-48 w-full" /></div>;
  if (list.length === 0) {
    return (
      <EmptyState title="No project to work on yet" action={session.user?.role === 'admin' ? <Button asChild className="mt-2 h-11 sm:h-9"><Link to="/settings/projects">Add a project</Link></Button> : undefined}>
        {session.user?.role === 'admin' ? 'Add a GitHub repository first, then come back to create a task.' : 'Ask an administrator to add a GitHub repository.'}
      </EmptyState>
    );
  }
  const unknown = initial && !list.some((p) => p.name === initial);
  const claudeIssue = error?.code === 'claude_not_connected' || error?.code === 'claude_expired';

  return (
    <form onSubmit={submit} onKeyDown={onKey} className="mx-auto max-w-3xl space-y-5" noValidate>
      <PageHeader title="New task" description="Describe the change. An agent works on it in its own branch and preview." className="mb-0" />
      {unknown && <Note tone="warn">There is no project called “{initial}”. Choose one below.</Note>}
      <div className="space-y-1.5">
        <Label htmlFor="nt-project">Project</Label>
        <Select value={project} onValueChange={(v) => { setProject(v); setErrs((e) => ({ ...e, project: '' })); }}>
          <SelectTrigger id="nt-project" className="h-11 w-full sm:h-9" aria-invalid={!!errs.project} aria-describedby="nt-project-err"><SelectValue placeholder="Choose a project" /></SelectTrigger>
          <SelectContent>{list.map((p) => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
        <Err id="nt-project-err">{errs.project}</Err>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nt-prompt">What should the agent do?</Label>
        <Textarea id="nt-prompt" ref={promptRef} rows={8} className="min-h-48" value={prompt} onChange={(e) => { setPrompt(e.target.value); setErrs((x) => ({ ...x, prompt: '' })); }}
          placeholder="Add a dark mode toggle to the settings page…" aria-invalid={!!errs.prompt} aria-describedby="nt-prompt-help nt-prompt-err" />
        <Help id="nt-prompt-help">Be specific about the goal and how to check it. Press Ctrl/Cmd+Enter to create the task.</Help>
        <Err id="nt-prompt-err">{errs.prompt}</Err>
      </div>
      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="-ml-3 h-11 sm:h-9" aria-expanded={advanced}>
            <ChevronDown className={advanced ? 'rotate-180 transition-transform' : 'transition-transform'} />Advanced options
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="nt-name">Name (optional)</Label>
            <Input id="nt-name" value={name} onChange={(e) => { setName(e.target.value.toLowerCase()); setErrs((x) => ({ ...x, name: '' })); }} placeholder="dark-mode" autoComplete="off" spellCheck={false} className="h-11 font-mono sm:h-9" aria-invalid={!!errs.name} aria-describedby="nt-name-help nt-name-err" />
            <Help id="nt-name-help">Lowercase letters, digits and dashes. If empty, the server derives one from your prompt. It becomes the git branch and the preview address: <span className="font-mono">{name || '<name>'}-{project || '<project>'}.{session.domain}</span></Help>
            <Err id="nt-name-err">{errs.name}</Err>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nt-success">Success command</Label>
            <Input id="nt-success" value={successCommand} onChange={(e) => setSuccessCommand(e.target.value)} placeholder="npm test" autoComplete="off" spellCheck={false} className="h-11 font-mono sm:h-9" aria-describedby="nt-success-help" />
            <Help id="nt-success-help">Run after each attempt; the task is done when it exits with 0. Empty = the project’s default.</Help>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nt-iter">Max attempts</Label>
              <Input id="nt-iter" type="number" inputMode="numeric" min={1} step={1} value={maxIterations} onChange={(e) => { setMaxIterations(e.target.value); setErrs((x) => ({ ...x, maxIterations: '' })); }} placeholder="Project default" className="h-11 sm:h-9" aria-invalid={!!errs.maxIterations} aria-describedby="nt-iter-err" />
              <Err id="nt-iter-err">{errs.maxIterations}</Err>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nt-cost">Max budget (USD)</Label>
              <Input id="nt-cost" type="number" inputMode="decimal" min={0} step="any" value={maxCostUsd} onChange={(e) => { setMaxCostUsd(e.target.value); setErrs((x) => ({ ...x, maxCostUsd: '' })); }} placeholder="Project default" className="h-11 sm:h-9" aria-invalid={!!errs.maxCostUsd} aria-describedby="nt-cost-help nt-cost-err" />
              <Help id="nt-cost-help">With a Claude subscription this is a consumption safeguard, measured in API-equivalent dollars.</Help>
              <Err id="nt-cost-err">{errs.maxCostUsd}</Err>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nt-base">Base branch</Label>
            <Input id="nt-base" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder={list.find((p) => p.name === project)?.defaultBranch ?? 'main'} autoComplete="off" spellCheck={false} className="h-11 font-mono sm:h-9" />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {error && (
        <Note tone="error" title="The task was not created">
          {error.message}{claudeIssue && <> <Link to="/settings/claude" className="font-medium underline underline-offset-4">Open Claude settings</Link></>}
          <span className="mt-1 block text-xs">Your text is kept: fix the problem and try again.</span>
        </Note>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <AsyncButton type="submit" busy={busy} busyLabel="Creating the task…" className="h-11 sm:h-9">Create task</AsyncButton>
        <Button asChild variant="ghost" className="h-11 sm:h-9"><Link to={initial && !unknown ? `/projects/${encodeURIComponent(initial)}` : '/'}>Cancel</Link></Button>
      </div>
      <ConnectChatHint connected={session.mcpConnected} />
    </form>
  );
}
