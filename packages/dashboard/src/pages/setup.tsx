import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, CopyField, DnsRecords, ErrorNote, navigate, Spinner, useAsync } from '../ui';
import { ChatConnect, ClaudeConnect, claudeSummary } from './connect';
import { RepoPicker, TokenAction } from './settings';

interface SetupState {
  domain: string; baseUrl: string; publicIp: string | null; sslip: boolean; githubConfigured: boolean; appSlug: string | null; installUrl: string | null;
  installed: boolean; repoCount: number; user: { login: string; role: string } | null; mcpUrl: string; setupOpen: boolean;
  claude: { connected: boolean; kind: 'oauth' | 'apikey' | null; expiresAt: string | null; expired: boolean };
}
const STEPS = [['domain', 'Address'], ['github', 'GitHub'], ['repos', 'Repositories'], ['claude', 'Claude'], ['chat', 'Chat']] as const;
type Step = (typeof STEPS)[number][0];

function Stepper({ step, reached }: { step: Step; reached: number }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {STEPS.map(([k, l], i) => <li key={k} className={k === step ? 'on' : i < reached ? 'done' : ''}><span>{i + 1}</span><em>{l}</em></li>)}
    </ol>
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
  return (
    <section className="card">
      <h2>Choose your address</h2>
      <p>Your bivouac is reachable at <b>{st.domain}</b>. That works as is. To use your own domain instead, enter it below.</p>
      <input placeholder="bv.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Your domain" />
      {d.includes('.') && <DnsRecords domain={d} ip={st.publicIp} />}
      {phase !== 'idle' && <p className="note">{info}</p>}
      <ErrorNote>{a.error}</ErrorNote>
      <div className="actions">
        <Button variant={d.includes('.') ? 'primary' : 'secondary'} disabled={!d.includes('.') || phase !== 'idle'} busy={phase !== 'idle'} busyLabel={phase === 'cert' ? 'Getting the certificate…' : 'Waiting for the DNS records…'} onClick={verify}>Verify</Button>
        <Button variant={d.includes('.') ? 'ghost' : 'primary'} onClick={next}>Keep {st.sslip ? 'this address' : st.domain}</Button>
      </div>
    </section>
  );
}

function GithubStep({ st }: { st: SetupState }) {
  const [kind, setKind] = useState<'personal' | 'org'>('personal');
  const [org, setOrg] = useState('');
  const [lookup, setLookup] = useState<{ state: 'idle' | 'checking' | 'found' | 'missing' | 'error'; name?: string | null; avatarUrl?: string | null; login?: string; message?: string }>({ state: 'idle' });
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
  return (
    <section className="card">
      <h2>Connect GitHub</h2>
      <p>bivouac creates a private GitHub app that only belongs to you. It is used to sign you in and to access the repositories you choose, nothing else.</p>
      <fieldset className="choices">
        <legend className="muted">Where should the app live?</legend>
        <label className="choice"><input type="radio" name="owner" checked={kind === 'personal'} onChange={() => setKind('personal')} />
          <span><b>Personal account</b> <span className="tag">recommended</span><br /><span className="muted">Recommended. You can add repositories from an organisation later, one at a time, with a fine-grained token.</span></span></label>
        <label className="choice"><input type="radio" name="owner" checked={kind === 'org'} onChange={() => setKind('org')} />
          <span><b>Organisation</b></span></label>
      </fieldset>
      {kind === 'org' && (
        <div className="stack">
          <p className="note warn">The app will be visible to the owners of the organisation, and its commits and pull requests will appear under the bot’s name. You must be an owner of the organisation; otherwise GitHub sends an approval request to the owners.</p>
          <input placeholder="organisation name" value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Organisation" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          {lookup.state === 'checking' && <p className="muted" role="status"><i className="spin" aria-hidden="true" />Looking up the organisation…</p>}
          {lookup.state === 'found' && <p className="org-found" role="status">{lookup.avatarUrl && <img src={lookup.avatarUrl} alt="" width="32" height="32" />}<span><b>{lookup.name ?? lookup.login}</b> <span className="muted">github.com/{lookup.login}</span></span></p>}
          {lookup.state === 'missing' && <p className="note error" role="alert">Organisation not found. Check the name as it appears in github.com/&lt;name&gt;.</p>}
          {lookup.state === 'error' && <p className="note error" role="alert">{lookup.message}</p>}
        </div>
      )}
      <ErrorNote>{a.error}</ErrorNote>
      <Button variant="primary" busy={a.busy} busyLabel="Preparing the GitHub app…" disabled={!ready} onClick={() => a.run(async () => setManifest(await api('POST', '/api/setup/github/manifest', { organization: kind === 'org' ? (lookup.login ?? org.trim()) : undefined })))}>Continue to GitHub</Button>
      <p className="muted">GitHub will ask you to confirm the app name, then bring you back here. {st.githubConfigured ? 'A previous app exists and will be replaced.' : ''}</p>
      {manifest && <form ref={form} method="post" action={manifest.action}><input type="hidden" name="manifest" value={manifest.manifest} /></form>}
    </section>
  );
}

export function Setup({ onFinished }: { onFinished: () => void }) {
  const [st, setSt] = useState<SetupState | null>(null);
  const [denied, setDenied] = useState(false);
  const params = new URLSearchParams(location.search);
  const code = params.get('code') ?? '';
  const error = params.get('error');
  const [step, setStep] = useState<Step | null>((params.get('step') as Step) ?? null);
  const load = useCallback(() => { void api('GET', '/api/setup/state').then(setSt).catch(() => setDenied(true)); }, []);
  useEffect(load, [load]);
  if (denied) {
    return (
      <section className="card center-card">
        <h1>Setup link needed</h1>
        <p>Open the setup link printed by the installer. If you lost it, run this on your server to get a new one:</p>
        <CopyField value="sudo bivouac reset-admin" />
      </section>
    );
  }
  if (!st) return <Spinner />;

  const current: Step = step ?? (st.githubConfigured && st.user ? 'repos' : 'domain');
  const reached = STEPS.findIndex(([k]) => k === current);
  const go = (s: Step) => { setStep(s); history.replaceState(null, '', `/setup?step=${s}`); load(); };
  const errText: Record<string, string> = { github_state: 'The GitHub step expired. Please start it again.', github_create: 'GitHub did not create the app. Please try again.' };

  return (
    <>
      <h1>Set up bivouac</h1>
      <Stepper step={current} reached={reached} />
      {error && <p className="note error">{errText[error] ?? 'Something went wrong. Please try again.'}</p>}
      {current === 'domain' && <DomainStep st={st} code={code} next={() => go('github')} />}
      {current === 'github' && (st.githubConfigured && st.user
        ? <section className="card"><h2>GitHub is connected</h2><p>Signed in as <b>{st.user.login}</b>.</p><Button variant="primary" onClick={() => go('repos')}>Continue</Button></section>
        : <GithubStep st={st} />)}
      {current === 'repos' && (
        <section className="card">
          <h2>Choose your repositories</h2>
          {st.installed ? <p>These repositories are shared with bivouac. Add the ones you want to work on.</p> : <p>Tell GitHub which repositories bivouac may use. You can change this at any time.</p>}
          {st.installed ? <RepoPicker onAdded={load} /> : <div className="stack"><a className="btn primary" href={st.installUrl ?? '#'}>Choose repositories on GitHub</a><TokenAction onAdded={load} /></div>}
          <div className="actions"><Button variant={st.installed ? 'primary' : 'ghost'} onClick={() => go('claude')}>{st.installed ? 'Continue' : 'Skip for now'}</Button></div>
        </section>
      )}
      {current === 'claude' && (
        <section className="card">
          <h2>Connect Claude</h2>
          <p className={`status-line ${claudeSummary(st.claude).ok ? 'ok' : 'bad'}`}><i className="dot" />{claudeSummary(st.claude).text}</p>
          <ClaudeConnect status={st.claude} onChange={load} />
          <div className="actions"><Button variant={st.claude.connected ? 'primary' : 'ghost'} onClick={() => go('chat')}>{st.claude.connected ? 'Continue' : 'Skip for now'}</Button></div>
        </section>
      )}
      {current === 'chat' && (
        <section className="card">
          <h2>Connect your chat</h2>
          <p>Add bivouac to Claude or ChatGPT, then ask it to start tasks for you.</p>
          <ChatConnect mcpUrl={st.mcpUrl} />
          <div className="actions"><Button variant="primary" onClick={() => { onFinished(); navigate('/'); }}>Go to the dashboard</Button></div>
        </section>
      )}
    </>
  );
}
