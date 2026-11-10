import { FolderGit2, Plus } from 'lucide-react';
import { api, type ClaudeAccount, type ProjectWithTotals, type Session } from '@/api';
import { ConnectChatCard } from '@/components/app/connect-chat-card';
import { EmptyState, Note, PageHeader } from '@/components/app/misc';
import { ProjectCard } from '@/components/app/project-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useLoad, useNow, useStream } from '@/lib/hooks';
import { Link } from '@/lib/router';

/** The one thing that blocks starting tasks, if any. */
function NextStep({ accounts, session }: { accounts: ClaudeAccount[] | null; session: Session }) {
  const admin = session.user?.role === 'admin';
  if (accounts && !accounts.some((a) => !a.expired)) {
    const expired = accounts.length > 0;
    return (
      <Note tone="warn" title={expired ? 'Your Claude token expired' : 'Claude is not connected'}>
        {expired ? 'Reconnect it so tasks can run again. ' : 'Agents need a Claude account to work. '}
        {admin ? <Link to="/settings/claude" className="font-medium underline underline-offset-4">{expired ? 'Reconnect Claude' : 'Connect Claude'}</Link> : 'Ask an administrator to connect one.'}
      </Note>
    );
  }
  if (!session.githubReady) {
    return (
      <Note tone="warn" title="GitHub is not connected">
        Projects and pull requests need GitHub. {admin ? <Link to="/settings/projects" className="font-medium underline underline-offset-4">Connect GitHub in Settings</Link> : 'Ask an administrator to connect it.'}
      </Note>
    );
  }
  return null;
}

export function Home({ session }: { session: Session }) {
  const projects = useLoad(() => api<ProjectWithTotals[]>('GET', '/api/projects'));
  const accounts = useLoad(() => api<ClaudeAccount[]>('GET', '/api/claude/accounts').catch(() => null));
  const reload = projects.reload;
  useStream('/api/stream', { task: reload, project: reload });
  const now = useNow(true);
  const admin = session.user?.role === 'admin';
  const list = projects.data;

  return (
    <div className="space-y-6">
      <PageHeader title="Projects" actions={list && list.length > 0 && <Button asChild className="h-11 sm:h-9"><Link to="/new"><Plus />New task</Link></Button>} />
      <NextStep accounts={accounts.data} session={session} />
      <ConnectChatCard mcpUrl={session.mcpUrl} connected={session.mcpConnected} />
      {projects.error && !list && <Note tone="error" title="Could not load the projects">{projects.error}. Reload the page to try again.</Note>}
      {!list && !projects.error && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64 w-full" />)}</div>
      )}
      {list && list.length === 0 && (
        <EmptyState icon={FolderGit2} title="No project yet" action={admin ? <Button asChild className="mt-2 h-11 sm:h-9"><Link to="/settings/projects">Add a project</Link></Button> : undefined}>
          {admin ? 'Pick a GitHub repository for the agents to work on.' : 'Ask an administrator to add a GitHub repository.'}
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{list.map((p) => <ProjectCard key={p.id} p={p} now={now} />)}</div>
      )}
    </div>
  );
}
