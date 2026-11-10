import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { api } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ChatConnect } from '@/components/app/chat-connect';
import { ClaudeConnect, ClaudeHelp } from '@/components/app/claude-connect';
import { DnsRecords } from '@/components/app/dns-records';
import { CopyField, ErrorNote, Note } from '@/components/app/misc';
import { RepoPicker, TokenRepoForm } from '@/components/app/repo-picker';
import { SetupStepper } from '@/components/app/setup-stepper';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageSkeleton } from '@/components/app/misc';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useAsync } from '@/lib/hooks';
import { navigate } from '@/lib/router';

interface SetupState {
  domain: string; baseUrl: string; publicIp: string | null; sslip: boolean; githubConfigured: boolean; appSlug: string | null; installUrl: string | null;
  installed: boolean; repoCount: number; user: { login: string; role: string } | null; mcpUrl: string; setupOpen: boolean;
  claude: { connected: boolean; kind: 'oauth' | 'apikey' | null; expiresAt: string | null; expired: boolean };
}
const STEPS = [{ id: 'domain', label: 'Address' }, { id: 'github', label: 'GitHub' }, { id: 'repos', label: 'Repositories' }, { id: 'claude', label: 'Claude' }, { id: 'chat', label: 'Chat' }] as const;
type Step = (typeof STEPS)[number]['id'];

const BTN = 'h-11 sm:h-9';

function StepCard({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
        {description && <CardDescription className="text-sm">{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        {children}
        <div className="flex flex-wrap gap-2 pt-2">{actions}</div>
      </CardContent>
    </Card>
  );
}

function DomainStep({ st, code, next }: { st: SetupState; code: string; next: () => void }) {
  const [domain, setDomain] = useState('');
  const [phase, setPhase] = useState<'idle' | 'dns' | 'cert'>('idle');
  const [info, setInfo] = useState('');
  const a = useAsync();
  const d = domain.trim().toLowerCase();
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  const verify = () => a.run(async () => {
    stop.current = false; setPhase('dns'); setInfo('Waiting for the DNS records…');
    // DNS can take a while to propagate: keep checking for up to 10 minutes
    for (let i = 0; i < 120 && !stop.current; i++) {
      const r = await api('POST', '/api/setup/domain/check', { domain: d });
      if (r.ok) {
        setPhase('cert'); setInfo('Records found. Getting your secure certificate…');
        const ap = await api('POST', '/api/setup/domain/apply', { domain: d, code });
        // wait until the new address answers over HTTPS with a valid certificate, then move there
        for (let j = 0; j < 90 && !stop.current; j++) {
          const ok = await fetch(`https://${d}/api/health`, { mode: 'no-cors' }).then(() => true).catch(() => false);
          if (ok) { location.href = ap.redirect; return; }
          await new Promise((res) => setTimeout(res, 2000));
        }
        throw new Error('The certificate is taking too long. Check that ports 80 and 443 are open, then try again.');
      }
      if (r.error) throw new Error(r.error);
      await new Promise((res) => setTimeout(res, 5000));
    }
    throw new Error('The DNS records were not found. Check them, then try again.');
  }).finally(() => setPhase('idle'));
  const valid = d.includes('.');
  const working = phase !== 'idle';
  return (
    <StepCard
      title="Choose your address"
      description={<>Your bivouac is reachable at <b className="text-foreground">{st.domain}</b>. That works as is. To use your own domain instead, enter it below.</>}
      actions={<>
        <AsyncButton size="lg" className={BTN} variant={valid ? 'default' : 'secondary'} disabled={!valid} busy={working} busyLabel={phase === 'cert' ? 'Getting the certificate…' : 'Waiting for the DNS records…'} onClick={verify}>Verify</AsyncButton>
        <Button size="lg" className={BTN} variant={valid ? 'ghost' : 'default'} disabled={working} onClick={next}>Keep {st.sslip ? 'this address' : st.domain}</Button>
      </>}
    >
      <div className="space-y-1.5">
        <Label htmlFor="setup-domain">Your domain</Label>
        <Input id="setup-domain" placeholder="bv.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} disabled={working} autoCapitalize="none" spellCheck={false} />
      </div>
      {valid && <DnsRecords domain={d} ip={st.publicIp} />}
      {working && <Note tone="info"><span role="status">{info}</span></Note>}
      <ErrorNote>{a.error}</ErrorNote>
    </StepCard>
  );
}

type Lookup = { state: 'idle' | 'checking' | 'found' | 'missing' | 'error'; name?: string | null; avatarUrl?: string | null; login?: string; message?: string };

function GithubStep({ st }: { st: SetupState }) {
  const [kind, setKind] = useState<'personal' | 'org'>('personal');
  const [org, setOrg] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const form = useRef<HTMLFormElement>(null);
  const [manifest, setManifest] = useState<{ action: string; manifest: string } | null>(null);
  const a = useAsync();
  useEffect(() => { if (manifest) form.current?.submit(); }, [manifest]);
  // validate the organisation while typing (debounced), through GitHub's public API
  useEffect(() => {
    const name = org.trim();
    if (kind !== 'org' || !name) { setLookup({ state: 'idle' }); return; }
    setLookup({ state: 'checking' });
    let live = true;
    const t = setTimeout(() => {
      api('GET', `/api/setup/github/org?name=${encodeURIComponent(name)}`)
        .then((r) => { if (live) setLookup(r.found ? { state: 'found', name: r.name, avatarUrl: r.avatarUrl, login: r.login } : { state: 'missing' }); })
        .catch((e) => { if (live) setLookup({ state: 'error', message: (e as Error).message }); });
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [org, kind]);
  const ready = kind === 'personal' || lookup.state === 'found';
  const waiting = a.busy || !!manifest;
  return (
    <StepCard
      title="Connect GitHub"
      description="bivouac creates a private GitHub app that only belongs to you. It is used to sign you in and to access the repositories you choose, nothing else."
      actions={<AsyncButton size="lg" className={BTN} busy={waiting} busyLabel="Preparing the GitHub app…" disabled={!ready}
        onClick={() => a.run(async () => setManifest(await api('POST', '/api/setup/github/manifest', { organization: kind === 'org' ? (lookup.login ?? org.trim()) : undefined })))}>Continue to GitHub</AsyncButton>}
    >
      <RadioGroup value={kind} onValueChange={(v) => setKind(v as 'personal' | 'org')} aria-label="Where should the app live?">
        <Label htmlFor="owner-personal" className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary">
          <RadioGroupItem id="owner-personal" value="personal" className="mt-0.5" />
          <span className="space-y-0.5"><span className="flex items-center gap-2 font-medium">Personal account <Badge variant="secondary">Recommended</Badge></span>
            <span className="block text-sm font-normal text-muted-foreground">Recommended. You can add repositories of an organisation later, one at a time, with a fine-grained token.</span></span>
        </Label>
        <Label htmlFor="owner-org" className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary">
          <RadioGroupItem id="owner-org" value="org" className="mt-0.5" />
          <span className="font-medium">Organisation</span>
        </Label>
      </RadioGroup>
      {kind === 'org' && (
        <div className="space-y-3">
          <Note tone="warn">The app will be visible to the owners of the organisation, and its commits and pull requests will appear under the bot’s name. You must be an owner of the organisation; otherwise GitHub sends an approval request to the owners.</Note>
          <div className="space-y-1.5">
            <Label htmlFor="setup-org">Organisation name</Label>
            <Input id="setup-org" placeholder="organisation name" value={org} onChange={(e) => setOrg(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={lookup.state === 'missing' || lookup.state === 'error' || undefined} />
          </div>
          {lookup.state === 'checking' && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Looking up the organisation…</p>}
          {lookup.state === 'found' && (
            <div className="flex items-center gap-3" role="status">
              <Avatar className="size-8"><AvatarImage src={lookup.avatarUrl ?? undefined} alt="" /><AvatarFallback>{(lookup.login ?? '?').slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
              <span className="text-sm"><b>{lookup.name ?? lookup.login}</b> <span className="text-muted-foreground">github.com/{lookup.login}</span></span>
            </div>
          )}
          {lookup.state === 'missing' && <Note tone="error">Organisation not found. Check the name as it appears in github.com/&lt;name&gt;.</Note>}
          {lookup.state === 'error' && <Note tone="error">{lookup.message}</Note>}
        </div>
      )}
      <ErrorNote>{a.error}</ErrorNote>
      <p className="text-sm text-muted-foreground">GitHub will ask you to confirm the app name, then bring you back here. {st.githubConfigured ? 'A previous app exists and will be replaced.' : ''}</p>
      {manifest && <form ref={form} method="post" action={manifest.action}><input type="hidden" name="manifest" value={manifest.manifest} /></form>}
    </StepCard>
  );
}

function ReposStep({ st, reload, next }: { st: SetupState; reload: () => void; next: () => void }) {
  const [showToken, setShowToken] = useState(false);
  return (
    <StepCard
      title="Choose your repositories"
      description={st.installed ? 'These repositories are shared with bivouac. Add the ones you want to work on.' : 'Tell GitHub which repositories bivouac may use. You can change this at any time.'}
      actions={<Button size="lg" className={BTN} variant={st.installed && st.repoCount > 0 ? 'default' : st.installed ? 'secondary' : 'ghost'} onClick={next}>{st.installed ? 'Continue' : 'Skip for now'}</Button>}
    >
      {st.installed ? <RepoPicker onAdded={reload} /> : (
        <div className="space-y-4">
          {st.installUrl && <Button asChild size="lg" className={BTN}><a href={st.installUrl}><ExternalLink />Choose repositories on GitHub</a></Button>}
          <div className="space-y-3">
            <Button variant="outline" className={BTN} aria-expanded={showToken} onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide the token form' : 'Add a repository with a token'}</Button>
            {showToken && <div className="rounded-lg border p-4"><TokenRepoForm onAdded={() => { setShowToken(false); reload(); }} /></div>}
          </div>
        </div>
      )}
    </StepCard>
  );
}

export function Setup({ onFinished }: { onFinished: () => void }) {
  const [st, setSt] = useState<SetupState | null>(null);
  const [denied, setDenied] = useState(false);
  const params = new URLSearchParams(location.search);
  const code = params.get('code') ?? '';
  const error = params.get('error');
  const [step, setStep] = useState<Step | null>((params.get('step') as Step) ?? null);
  const load = useCallback(() => { void api<SetupState>('GET', '/api/setup/state').then(setSt).catch(() => setDenied(true)); }, []);
  useEffect(load, [load]);

  if (denied) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader><CardTitle className="text-xl">Setup link needed</CardTitle><CardDescription>Open the setup link printed by the installer. If you lost it, run this on your server to get a new one:</CardDescription></CardHeader>
        <CardContent><CopyField value="sudo bivouac reset-admin" /></CardContent>
      </Card>
    );
  }
  if (!st) return <PageSkeleton />;

  const current: Step = step ?? (st.githubConfigured && st.user ? 'repos' : 'domain');
  const go = (s: Step) => { setStep(s); history.replaceState(null, '', `/setup?step=${s}`); load(); };
  const errText: Record<string, string> = { github_state: 'The GitHub step expired. Please start it again.', github_create: 'GitHub did not create the app. Please try again.' };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Set up bivouac</h1>
      <SetupStepper steps={STEPS} current={current} />
      {error && <div className="mb-4"><Note tone="error">{errText[error] ?? 'Something went wrong. Please try again.'}</Note></div>}
      {current === 'domain' && <DomainStep st={st} code={code} next={() => go('github')} />}
      {current === 'github' && (st.githubConfigured && st.user
        ? <StepCard title="GitHub is connected" description={<>Signed in as <b className="text-foreground">{st.user.login}</b>.</>} actions={<Button size="lg" className={BTN} onClick={() => go('repos')}>Continue</Button>}><span /></StepCard>
        : <GithubStep st={st} />)}
      {current === 'repos' && <ReposStep st={st} reload={load} next={() => go('claude')} />}
      {current === 'claude' && (
        <StepCard
          title="Connect Claude"
          description="Tasks run with your Claude subscription or an API key."
          actions={<Button size="lg" className={BTN} variant={st.claude.connected ? 'default' : 'ghost'} onClick={() => go('chat')}>{st.claude.connected ? 'Continue' : 'Skip for now'}</Button>}
        >
          <ClaudeHelp />
          {st.claude.connected && !st.claude.expired
            ? <Note tone="ok">Claude is connected{st.claude.kind === 'apikey' ? ' with an API key' : ''}.</Note>
            : <ClaudeConnect defaultName="Default" onDone={load} />}
        </StepCard>
      )}
      {current === 'chat' && (
        <StepCard
          title="Connect your chat"
          description="Add bivouac to Claude or ChatGPT, then ask it to start tasks for you."
          actions={<AsyncButton size="lg" className={BTN} busyLabel="Opening the dashboard…" onClick={() => { onFinished(); navigate('/'); }}>Go to the dashboard</AsyncButton>}
        >
          <ChatConnect mcpUrl={st.mcpUrl} />
        </StepCard>
      )}
    </div>
  );
}
