import { useCallback, useEffect, useState } from 'react';
import { api, type Session } from './api';
import { Authorize, Login } from './pages/auth';
import { Home } from './pages/home';
import { ConnectPage, Settings } from './pages/settings';
import { Setup } from './pages/setup';
import { UpdateBanner, UpdatePage } from './pages/update';
import { TaskPage } from './pages/task';
import { Link, navigate, Spinner, useLocation, useTheme } from './ui';

function Header({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const u = session.user;
  return (
    <header className="topbar">
      <Link to="/" className="brand"><img src="/favicon.svg" alt="" width="26" height="26" className="logo" /> bivouac</Link>
      {u && (
        <div className="menu-wrap">
          <button className="avatar" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            {u.avatarUrl ? <img src={u.avatarUrl} alt="" width="32" height="32" /> : <span>{u.login[0].toUpperCase()}</span>}
          </button>
          {open && (
            <div className="menu" onClick={() => setOpen(false)}>
              <p className="muted">{u.login}</p>
              <Link to="/settings">Settings</Link>
              <Link to="/connect">Connect your chat</Link>
              <button onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}>Theme: {theme}</button>
              <button onClick={async () => { await api('POST', '/api/logout'); location.href = '/login'; }}>Sign out</button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

export function App() {
  const loc = useLocation();
  const [session, setSession] = useState<Session | null>(null);
  const refresh = useCallback(() => api<Session>('GET', '/api/session').then(setSession), []);
  useEffect(() => { void refresh(); }, [refresh]);
  useTheme();
  const path = loc.split('?')[0];

  useEffect(() => {
    if (!session) return;
    const open = path === '/login' || path === '/setup';
    if (!session.user && !open) {
      // consent screens bring the user back after signing in
      if (path === '/oauth/authorize') navigate(`/login?next=${encodeURIComponent(loc)}`, true);
      else navigate('/login', true);
    } else if (session.user && path === '/login') navigate(new URLSearchParams(location.search).get('next') ?? '/', true);
  }, [session, path, loc]);

  if (!session) return <Spinner />;
  const m = /^\/projects\/([^/]+)\/([^/]+)$/.exec(path);
  let page;
  if (path === '/setup') page = <Setup onFinished={() => void refresh()} />;
  else if (path === '/login') page = <Login session={session} />;
  else if (!session.user) page = <Spinner />;
  else if (path === '/oauth/authorize') page = <Authorize />;
  else if (path === '/settings') page = <Settings />;
  else if (path === '/update' && session.user.role === 'admin') page = <UpdatePage loadedVersion={session.version} />;
  else if (path === '/connect') page = <ConnectPage mcpUrl={session.mcpUrl} />;
  else if (m) page = <TaskPage key={m[1] + m[2]} project={decodeURIComponent(m[1])} name={decodeURIComponent(m[2])} />;
  else page = <Home session={session} />;
  return (
    <div className="shell">
      <Header session={session} />
      {session.user?.role === 'admin' && path !== '/update' && path !== '/setup' && path !== '/oauth/authorize' && <UpdateBanner enabled />}
      <main>{page}</main>
      <footer className="foot muted">bivouac {session.version}</footer>
    </div>
  );
}
