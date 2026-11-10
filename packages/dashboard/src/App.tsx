import { useCallback, useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api, type Session } from '@/api';
import { PageSkeleton } from '@/components/app/misc';
import { Shell } from '@/components/app/shell';
import { UpdateBanner } from '@/components/app/update-banner';
import { matchPath, navigate, parseLocation, useLocation } from '@/lib/router';
import { Authorize, Login } from '@/pages/auth';
import { Home } from '@/pages/home';
import { NewTaskPage } from '@/pages/new-task';
import { ProjectPage } from '@/pages/project';
import { Settings } from '@/pages/settings';
import { Setup } from '@/pages/setup';
import { TaskPage } from '@/pages/task';

export function App() {
  const loc = useLocation();
  const { path } = parseLocation(loc);
  const [session, setSession] = useState<Session | null>(null);
  const refresh = useCallback(() => api<Session>('GET', '/api/session').then(setSession), []);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!session) return;
    const open = path === '/login' || path === '/setup';
    if (!session.user && !open) {
      // consent screens bring the user back after signing in
      if (path === '/oauth/authorize') navigate(`/login?next=${encodeURIComponent(loc)}`, true);
      else navigate('/login', true);
    } else if (session.user && path === '/login') navigate(new URLSearchParams(location.search).get('next') ?? '/', true);
    // older links
    if (session?.user && path === '/update') navigate('/settings/updates', true);
    if (session?.user && path === '/connect') navigate('/settings/chat', true);
  }, [session, path, loc]);

  if (!session) return <div className="mx-auto max-w-6xl p-6"><PageSkeleton /></div>;

  let page, wide = false;
  const proj = matchPath('/projects/:project', path), task = matchPath('/projects/:project/:task', path), settings = matchPath('/settings/:section', path);
  if (path === '/setup') page = <Setup onFinished={() => void refresh()} />;
  else if (path === '/login') page = <Login session={session} />;
  else if (!session.user) page = <PageSkeleton />;
  else if (path === '/oauth/authorize') page = <Authorize />;
  else if (path === '/settings' || settings) page = <Settings section={settings?.section ?? null} session={session} />;
  else if (path === '/new') page = <NewTaskPage project={parseLocation(loc).query.get('project')} session={session} />;
  else if (task && task.task === 'new') page = <NewTaskPage project={task.project} session={session} />;
  else if (task) { page = <TaskPage key={task.project + task.task} project={task.project} name={task.task} />; wide = true; }
  else if (proj) page = <ProjectPage key={proj.project} project={proj.project} session={session} />;
  else page = <Home session={session} />;

  const showBanner = session.user?.role === 'admin' && !['/setup', '/oauth/authorize', '/login'].includes(path) && !path.startsWith('/settings/updates');
  return (
    <TooltipProvider delayDuration={200}>
      <Shell session={session} path={path} wide={wide} banner={showBanner ? <UpdateBanner /> : undefined}>{page}</Shell>
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
