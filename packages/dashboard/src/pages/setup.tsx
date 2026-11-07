import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, CopyField, ErrorNote, navigate, Spinner, useAsync } from '../ui';
import { ChatConnect, ClaudeConnect, claudeSummary } from './connect';
import { RepoPicker } from './settings';

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
  const sub = d.split('.')[0] || 'bv';
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
      {d.includes('.') && (
        <div className="dns">
          <p className="muted">At your domain registrar, create these two records:</p>
          <table><tbody>
            <tr><td>A</td><td><code>{sub}</code></td><td><code>{st.publicIp ?? 'this server’s IP'}</code></td></tr>
            <tr><td>A</td><td><code>*.{sub}</code></td><td><code>{st.publicIp ?? 'this server’s IP'}</code></td></tr>
          </tbody></table>
        </div>
      )}
      {phase !== 'idle' && <p className="note">{info}</p>}
      <ErrorNote>{a.error}</ErrorNote>
      <div className="actions">
        <Button variant={d.includes('.') ? 'primary' : 'secondary'} disabled={!d.includes('.') || phase !== 'idle'} busy={phase !== 'idle'} onClick={verify}>Verify</Button>
        <Button variant={d.includes('.') ? 'ghost' : 'primary'} onClick={next}>Keep {st.sslip ? 'this address' : st.domain}</Button>
      </div>
    </section>
  );
}

function GithubStep({ st }: { st: SetupState }) {
  const [org, setOrg] = useState('');
  const [useOrg, setUseOrg] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const [manifest, setManifest] = useState<{ action: string; manifest: string } | null>(null);
  const a = useAsync();
  useEffect(() => { if (manifest) form.current?.submit(); }, [manifest]);
  return (
    <section className="card">
      <h2>Connect GitHub</h2>
      <p>bivouac creates a private GitHub app that only belongs to you. It is used to sign you in and to access the repositories you choose, nothing else.</p>
      <label className="check"><input type="checkbox" checked={useOrg} onChange={(e) => setUseOrg(e.target.checked)} /> Create it under an organisation</label>
      {useOrg && <input placeholder="organisation name" value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Organisation" />}
      <ErrorNote>{a.error}</ErrorNote>
      <Button variant="primary" busy={a.busy} disabled={useOrg && !org} onClick={() => a.run(async () => setManifest(await api('POST', '/api/setup/github/manifest', { organization: useOrg ? org : undefined })))}>Continue to GitHub</Button>
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
          {st.installed ? <RepoPicker onAdded={load} /> : <a className="btn primary" href={st.installUrl ?? '#'}>Choose repositories on GitHub</a>}
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
