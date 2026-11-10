import { Fragment, type ReactNode } from 'react';
import { LogOut, Settings as SettingsIcon } from 'lucide-react';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, type Session } from '@/api';
import { Link, navigate } from '@/lib/router';
import { ThemeToggle } from './theme-toggle';

export interface Crumb { label: string; to?: string }

/** Breadcrumb from the URL: /projects/<project>/<task>[/…] and /settings[/<section>]. */
export function crumbsFor(path: string): Crumb[] {
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (seg[0] === 'projects' && seg[1]) {
    const out: Crumb[] = [{ label: 'Projects', to: '/' }, { label: seg[1], to: `/projects/${encodeURIComponent(seg[1])}` }];
    if (seg[2] === 'new') out.push({ label: 'New task' });
    else if (seg[2]) out.push({ label: seg[2] });
    return out;
  }
  if (seg[0] === 'settings') return [{ label: 'Settings', to: '/settings' }, ...(seg[1] ? [{ label: seg[1][0].toUpperCase() + seg[1].slice(1) }] : [])];
  return [];
}

function Crumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (!crumbs.length) return null;
  return (
    <Breadcrumb className="mb-4">
      <BreadcrumbList>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {c.to && i < crumbs.length - 1 ? <BreadcrumbLink asChild><Link to={c.to}>{c.label}</Link></BreadcrumbLink> : <BreadcrumbPage className="max-w-[40vw] truncate">{c.label}</BreadcrumbPage>}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function UserMenu({ session }: { session: Session }) {
  const u = session.user!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
          <Avatar className="size-8"><AvatarImage src={u.avatarUrl ?? undefined} alt="" /><AvatarFallback>{u.login[0]?.toUpperCase()}</AvatarFallback></Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal"><span className="block truncate font-medium">{u.login}</span><span className="text-xs text-muted-foreground">{u.role === 'admin' ? 'Administrator' : 'Member'}</span></DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}><SettingsIcon />Settings</DropdownMenuItem>
        <DropdownMenuItem onSelect={async () => { await api('POST', '/api/logout'); location.href = '/login'; }}><LogOut />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Header, breadcrumb, optional banner and footer around every signed-in page. `wide` lifts the width limit (logs). */
export function Shell({ session, path, banner, children, wide }: { session: Session; path: string; banner?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight"><img src="/favicon.svg" alt="" width="24" height="24" />bivouac</Link>
          {session.user && (
            <nav className="ml-2 hidden items-center gap-1 text-sm sm:flex" aria-label="Main">
              <Button asChild variant="ghost" size="sm"><Link to="/">Projects</Link></Button>
              <Button asChild variant="ghost" size="sm"><Link to="/settings">Settings</Link></Button>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-1"><ThemeToggle />{session.user && <UserMenu session={session} />}</div>
        </div>
      </header>
      {banner}
      <main className={`mx-auto w-full flex-1 px-4 py-6 max-w-6xl`}>
        {session.user && <Crumbs crumbs={crumbsFor(path)} />}
        {children}
      </main>
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">bivouac {session.version}</footer>
    </div>
  );
}
