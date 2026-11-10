import { useEffect, useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, type Session } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { CopyField, ErrorNote, Note } from '@/components/app/misc';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync } from '@/lib/hooks';

const ERRORS: Record<string, string> = {
  not_allowed: 'This GitHub account is not allowed here. Ask an administrator to add you.',
  state: 'The sign-in took too long. Please try again.',
  github: 'GitHub could not confirm your sign-in. Please try again.',
  github_not_connected: 'GitHub is not connected yet.',
};

function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-md flex-col py-6 sm:py-12"><Card className="w-full">{children}</Card></div>;
}
const Logo = () => <img src="/favicon.svg" alt="" width="56" height="56" className="mx-auto mb-2 size-14" />;

export function Login({ session }: { session: Session }) {
  const q = new URLSearchParams(location.search);
  const next = q.get('next') ?? '/';
  const error = q.get('error');
  const [going, setGoing] = useState(false);
  return (
    <Centered>
      <CardHeader className="text-center">
        <Logo />
        <CardTitle className="text-2xl">bivouac</CardTitle>
        <CardDescription>Your agents’ camp. Sign in to follow your tasks.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Note tone="error">{ERRORS[error] ?? 'Sign-in failed. Please try again.'}</Note>}
        {session.githubReady ? (
          <AsyncButton busy={going} busyLabel="Redirecting to GitHub…" className="h-11 w-full" onClick={() => { setGoing(true); location.href = `/auth/github/start?next=${encodeURIComponent(next)}`; }}>
            Sign in with GitHub
          </AsyncButton>
        ) : (
          <>
            <Note>This instance is not set up yet. Open the setup link printed by the installer, or run this on your server:</Note>
            <CopyField value="sudo bivouac reset-admin" />
          </>
        )}
      </CardContent>
    </Centered>
  );
}

interface Info { client: { name: string }; redirectHost: string; user: string; rights: string[] }

/** OAuth consent screen for MCP clients (Claude, ChatGPT, …). */
export function Authorize() {
  const [info, setInfo] = useState<Info | null>(null);
  const [fatal, setFatal] = useState('');
  const [deciding, setDeciding] = useState<'approve' | 'deny' | null>(null);
  const a = useAsync();
  const params = Object.fromEntries(new URLSearchParams(location.search));
  useEffect(() => {
    api<Info>('GET', '/api/oauth/authorize-info' + location.search).then(setInfo).catch((e) => setFatal(e.message));
  }, []);
  const decide = async (decision: 'approve' | 'deny') => {
    setDeciding(decision);
    const done = await a.run(async () => { const r = await api<{ redirect: string }>('POST', '/api/oauth/authorize', { ...params, decision }); location.href = r.redirect; return true; });
    if (!done) setDeciding(null);
  };

  if (fatal) {
    return (
      <Centered>
        <CardHeader className="text-center"><CardTitle className="text-xl">Cannot connect</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <ErrorNote>{fatal}</ErrorNote>
          <p className="text-sm text-muted-foreground">Close this window and add the connector again from your chat app.</p>
        </CardContent>
      </Centered>
    );
  }
  if (!info) return <Centered><CardContent className="space-y-3" aria-busy="true"><Skeleton className="mx-auto size-14 rounded-full" /><Skeleton className="h-6 w-2/3" /><Skeleton className="h-20 w-full" /></CardContent></Centered>;
  return (
    <Centered>
      <CardHeader className="text-center">
        <Logo />
        <CardTitle className="text-xl">Allow {info.client.name}?</CardTitle>
        <CardDescription className="break-words"><b>{info.client.name}</b> ({info.redirectHost}) wants to use bivouac as <b>{info.user}</b>. It will be able to:</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2 text-sm">
          {info.rights.map((r) => <li key={r} className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />{r}</li>)}
        </ul>
        <ErrorNote>{a.error}</ErrorNote>
      </CardContent>
      <CardFooter className="flex-col gap-3">
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AsyncButton variant="ghost" className="h-11 sm:h-9" busy={deciding === 'deny' && a.busy} busyLabel="Cancelling…" disabled={a.busy} onClick={() => decide('deny')}>Cancel</AsyncButton>
          <AsyncButton className="h-11 sm:h-9" busy={deciding === 'approve' && a.busy} busyLabel="Allowing…" disabled={a.busy} onClick={() => decide('approve')}>Allow</AsyncButton>
        </div>
        <p className="text-xs text-muted-foreground">You can disconnect it at any time in Settings.</p>
      </CardFooter>
    </Centered>
  );
}
