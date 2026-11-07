import { useEffect, useState } from 'react';
import { api, type Session } from '../api';
import { Button, CopyField, ErrorNote, Spinner, useAsync } from '../ui';

const ERRORS: Record<string, string> = {
  not_allowed: 'This GitHub account is not allowed here. Ask an administrator to add you.',
  state: 'The sign-in took too long. Please try again.',
  github: 'GitHub could not confirm your sign-in. Please try again.',
  github_not_connected: 'GitHub is not connected yet.',
};

export function Login({ session }: { session: Session }) {
  const q = new URLSearchParams(location.search);
  const next = q.get('next') ?? '/';
  const error = q.get('error');
  return (
    <section className="card center-card">
      <img className="logo-lg" src="/favicon.svg" alt="" width="56" height="56" />
      <h1>bivouac</h1>
      <p className="muted">Your agents’ camp. Sign in to follow your tasks.</p>
      {error && <p className="note error">{ERRORS[error] ?? 'Sign-in failed. Please try again.'}</p>}
      {session.githubReady
        ? <a className="btn primary big" href={`/auth/github/start?next=${encodeURIComponent(next)}`}>Sign in with GitHub</a>
        : <><p className="note">This instance is not set up yet. Open the setup link printed by the installer, or run this on your server:</p><CopyField value="sudo bivouac reset-admin" /></>}
    </section>
  );
}

interface Info { client: { name: string }; redirectHost: string; user: string; rights: string[] }

/** OAuth consent screen for MCP clients (Claude, ChatGPT, …). */
export function Authorize() {
  const [info, setInfo] = useState<Info | null>(null);
  const [fatal, setFatal] = useState('');
  const a = useAsync();
  const params = Object.fromEntries(new URLSearchParams(location.search));
  useEffect(() => {
    api('GET', '/api/oauth/authorize-info' + location.search).then(setInfo).catch((e) => setFatal(e.message));
  }, []);
  const decide = (decision: 'approve' | 'deny') => a.run(async () => { const r = await api('POST', '/api/oauth/authorize', { ...params, decision }); location.href = r.redirect; });
  if (fatal) return <section className="card center-card"><h1>Cannot connect</h1><ErrorNote>{fatal}</ErrorNote><p className="muted">Close this window and add the connector again from your chat app.</p></section>;
  if (!info) return <Spinner />;
  return (
    <section className="card center-card">
      <img className="logo-lg" src="/favicon.svg" alt="" width="56" height="56" />
      <h1>Allow {info.client.name}?</h1>
      <p className="muted"><b>{info.client.name}</b> ({info.redirectHost}) wants to use bivouac as <b>{info.user}</b>. It will be able to:</p>
      <ul className="rights">{info.rights.map((r) => <li key={r}>{r}</li>)}</ul>
      <ErrorNote>{a.error}</ErrorNote>
      <div className="actions stretch">
        <Button variant="primary" busy={a.busy} onClick={() => decide('approve')}>Allow</Button>
        <Button variant="ghost" onClick={() => decide('deny')}>Cancel</Button>
      </div>
      <p className="muted small">You can disconnect it at any time in Settings.</p>
    </section>
  );
}
