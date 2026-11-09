import { useCallback, useEffect, useState } from 'react';
import { api, ago, type ProjectWithTotals } from '../api';
import { Button, Details, DnsRecords, ErrorNote, Spinner, useAsync, navigate } from '../ui';
import { ChatConnect, ClaudeConnect, claudeSummary } from './connect';
import { VersionSection } from './update';

interface SettingsData {
  admin: boolean; baseUrl: string; domain: string; sslip: boolean; publicIp: string | null; mcpUrl: string; version: string;
  claude: { connected: boolean; kind: 'oauth' | 'apikey' | null; expiresAt: string | null; expired: boolean };
  github: { configured: boolean; slug: string | null; installUrl: string | null; appUrl: string | null };
  budgets: { maxIterations: number | null; maxCostUsd: number | null };
  users: { githubId: number; login: string; role: string }[]; allowlist: { id: number; kind: string; value: string; label: string | null }[];
  redirectAllow: string[];
  grants: { id: string; clientName: string; login: string | null; createdAt: string; lastUsedAt: string | null }[];
}

function Section({ id, title, children, hint }: { id: string; title: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return <section className="card" id={id}><h2>{title}</h2>{hint}{children}</section>;
}

// ---------- GitHub repositories
export const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
/** Adds one repository with a fine-grained token (e.g. a repository of an organisation). The token is checked on save. */
export function TokenRepoForm({ onAdded }: { onAdded: () => void }) {
  const [repoUrl, setRepoUrl] = useState(''); const [token, setToken] = useState('');
  const a = useAsync();
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('POST', '/api/projects', { repoUrl: repoUrl.trim(), githubToken: token.trim() }); setRepoUrl(''); setToken(''); onAdded(); }); }}>
      <ol className="steps">
        <li><a href={TOKEN_URL} target="_blank" rel="noreferrer">Create a fine-grained token on GitHub ↗</a>. Under <b>Repository access</b>, choose <b>Only select repositories</b> and pick just this repository.</li>
        <li>Under <b>Repository permissions</b>, set exactly these (the rest stays on “No access”):
          <ul><li><b>Contents</b>: Read and write (clone, and push the task branch)</li><li><b>Pull requests</b>: Read and write (open the pull request)</li><li><b>Metadata</b>: Read (added automatically)</li></ul>
          For an organisation’s repository, the organisation’s owners may need to approve the token first.</li>
        <li>Paste the repository address and the token below. bivouac checks that the token works before saving it.</li>
      </ol>
      <input placeholder="https://github.com/your-org/your-app" aria-label="Repository address" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} autoCapitalize="none" spellCheck={false} />
      <input type="password" autoComplete="off" placeholder="github_pat_…" aria-label="Fine-grained token" value={token} onChange={(e) => setToken(e.target.value)} />
      <ErrorNote>{a.error}</ErrorNote>
      <Button disabled={!repoUrl.trim() || !token.trim()} busy={a.busy} busyLabel="Checking the token…" variant="primary">Add this repository</Button>
    </form>
  );
}

export function RepoPicker({ onAdded }: { onAdded: () => void }) {
  const [data, setData] = useState<{ configured: boolean; repos: { fullName: string; private: boolean; added: boolean }[]; installUrl: string | null } | null>(null);
  const a = useAsync();
  const load = useCallback(() => { void api('GET', '/api/github/repos').then(setData).catch((e) => a.setError(e.message)); }, [a]);
  useEffect(load, []);
  if (!data) return a.error ? <ErrorNote>{a.error}</ErrorNote> : <Spinner />;
  return (
    <div className="stack">
      {data.repos.length === 0 && <p className="muted">No repository is shared with bivouac yet.</p>}
      {data.repos.map((r) => (
        <div key={r.fullName} className="row-item">
          <span className="clip"><b>{r.fullName}</b> {r.private && <span className="tag">private</span>}</span>
          {r.added ? <span className="muted">Added</span> : <Button busyLabel="Adding…" onClick={() => a.run(async () => { await api('POST', '/api/projects', { fullName: r.fullName }); load(); onAdded(); })}>Add</Button>}
        </div>
      ))}
      <ErrorNote>{a.error}</ErrorNote>
      {data.installUrl && <a className="btn secondary" href={data.installUrl}>Choose repositories on GitHub</a>}
      <TokenAction onAdded={() => { load(); onAdded(); }} />
    </div>
  );
}

/** The always-visible way to add a repository the GitHub app cannot reach. */
export function TokenAction({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      <Button variant={open ? 'ghost' : 'secondary'} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Add a repository with a token'}</Button>
      {open && <TokenRepoForm onAdded={() => { setOpen(false); onAdded(); }} />}
    </div>
  );
}

function Projects({ s }: { s: SettingsData }) {
  const [projects, setProjects] = useState<ProjectWithTotals[]>([]);
  const [tick, setTick] = useState(0);
  const a = useAsync();
  useEffect(() => { void api('GET', '/api/projects').then(setProjects); }, [tick]);
  return (
    <Section id="projects" title="Projects">
      {projects.map((p) => (
        <div key={p.id} className="row-item"><span className="clip"><b>{p.name}</b> <span className="muted">{p.githubRepo ?? p.repoUrl}</span></span>
          <Button variant="ghost" busyLabel="Removing…" onClick={() => a.run(async () => { if (confirm(`Remove ${p.name} from bivouac? Your repository on GitHub is not touched.`)) { await api('DELETE', `/api/projects/${p.id}`); setTick(tick + 1); } })}>Remove</Button></div>
      ))}
      {projects.length === 0 && <p className="muted">No project yet. Pick a repository below.</p>}
      <ErrorNote>{a.error}</ErrorNote>
      {s.admin && s.github.configured && <Details title="Add a repository" open={projects.length === 0}><RepoPicker onAdded={() => setTick(tick + 1)} /></Details>}
      {s.admin && !s.github.configured && <TokenAction onAdded={() => setTick(tick + 1)} />}
    </Section>
  );
}

// ---------- domain
function Domain({ s }: { s: SettingsData }) {
  const [domain, setDomain] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; apex: string[]; wildcard: string[]; error?: string } | null>(null);
  const a = useAsync();
  const d = domain.trim().toLowerCase();
  return (
    <Section id="domain" title="Address">
      <p>Your bivouac lives at <b>{s.domain}</b>.</p>
      <Details title="Use my own domain">
        <div className="stack">
          <input placeholder="bv.example.com" value={domain} onChange={(e) => { setDomain(e.target.value); setCheck(null); }} />
          {d.includes('.') && <DnsRecords domain={d} ip={s.publicIp} />}
          {check && !check.ok && <p className="note">{check.error ?? 'The records are not visible yet. DNS can take a few minutes.'}</p>}
          <Button busyLabel="Checking the DNS records…" disabled={!d.includes('.')} onClick={() => a.run(async () => { const r = await api('POST', '/api/setup/domain/check', { domain: d }).catch(() => ({ ok: false, apex: [], wildcard: [], error: 'Setup tools are only available from the setup link. Run “sudo bivouac reset-admin” if needed.' })); setCheck(r); })}>Check</Button>
          {check?.ok && (
            <>
              <p className="note warn">Switching domain recreates the GitHub connection and disconnects your chat connectors. You will reconnect them afterwards.</p>
              <Button variant="danger" busyLabel="Switching…" onClick={() => a.run(async () => { const r = await api('POST', '/api/settings/domain', { domain: d }); location.href = r.redirect; })}>Switch to {d}</Button>
            </>
          )}
          <ErrorNote>{a.error}</ErrorNote>
        </div>
      </Details>
    </Section>
  );
}

// ---------- people
function People({ s, reload }: { s: SettingsData; reload: () => void }) {
  const [kind, setKind] = useState('user'); const [value, setValue] = useState('');
  const a = useAsync();
  return (
    <Section id="people" title="Who can sign in" hint={<p className="muted">People are identified by their permanent GitHub id. Administrators can always sign in.</p>}>
      {s.users.filter((u) => !s.allowlist.some((e) => e.kind === 'user' && e.value === String(u.githubId))).map((u) => <div key={u.githubId} className="row-item"><span><b>{u.login}</b> <span className="muted">{u.role === 'admin' ? 'administrator' : 'member'}</span></span></div>)}
      {s.allowlist.map((e) => (
        <div key={e.id} className="row-item"><span className="clip"><b>{e.label ?? e.value}</b> <span className="tag">{e.kind === 'user' ? 'person' : e.kind === 'org' ? 'organisation' : 'team'}</span></span>
          <Button variant="ghost" onClick={() => a.run(async () => { await api('DELETE', `/api/settings/allowlist/${e.id}`); reload(); })}>Remove</Button></div>
      ))}
      {s.admin && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('POST', '/api/settings/allowlist', { kind, value }); setValue(''); reload(); }); }}>
          <div className="stack wide-row">
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type"><option value="user">Person</option><option value="org">Organisation</option><option value="team">Team</option></select>
            <input placeholder={kind === 'user' ? 'GitHub username' : kind === 'org' ? 'organisation name' : 'organisation/team-name'} value={value} onChange={(e) => setValue(e.target.value)} />
            <Button disabled={!value} busy={a.busy} busyLabel="Adding…">Allow</Button>
          </div>
          <ErrorNote>{a.error}</ErrorNote>
        </form>
      )}
    </Section>
  );
}

function Apps({ s, reload }: { s: SettingsData; reload: () => void }) {
  const a = useAsync();
  return (
    <Section id="apps" title="Connected chat apps">
      {s.grants.length === 0 && <p className="muted">No app connected yet. <a href="/connect" onClick={(e) => { e.preventDefault(); navigate('/connect'); }}>Connect your chat</a></p>}
      {s.grants.map((g) => (
        <div key={g.id} className="row-item"><span className="clip"><b>{g.clientName}</b> <span className="muted">{g.lastUsedAt ? `used ${ago(g.lastUsedAt)}` : `connected ${ago(g.createdAt)}`}{g.login ? ` · ${g.login}` : ''}</span></span>
          <Button variant="ghost" onClick={() => a.run(async () => { await api('DELETE', `/api/settings/grants/${g.id}`); reload(); })}>Disconnect</Button></div>
      ))}
      <ErrorNote>{a.error}</ErrorNote>
    </Section>
  );
}

function Defaults({ s, reload }: { s: SettingsData; reload: () => void }) {
  const [it, setIt] = useState(String(s.budgets.maxIterations ?? '')); const [cost, setCost] = useState(String(s.budgets.maxCostUsd ?? ''));
  const a = useAsync();
  return (
    <Section id="budgets" title="Default limits" hint={<p className="muted">Applied to new tasks unless the project or the request says otherwise. Leave empty for the built-in defaults (10 attempts, $20). The dollar limit is a safeguard on consumption: with a Claude subscription the amount is the API-equivalent estimate reported by Claude, not money you spend.</p>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('PUT', '/api/settings/budgets', { maxIterations: it || null, maxCostUsd: cost || null }); reload(); }); }}>
        <label>Attempts per task<input inputMode="numeric" value={it} onChange={(e) => setIt(e.target.value)} placeholder="10" /></label>
        <label>Maximum spend per task (USD)<input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="20" /></label>
        <ErrorNote>{a.error}</ErrorNote>
        <Button disabled={!s.admin} busy={a.busy} busyLabel="Saving…">Save</Button>
      </form>
    </Section>
  );
}

function Activity() {
  const [rows, setRows] = useState<{ id: number; ts: string; actor: string; action: string; detail: any }[] | null>(null);
  return (
    <Details title="Recent activity">
      {rows === null ? <Button busyLabel="Loading…" onClick={() => api('GET', '/api/settings/audit?limit=60').then(setRows)}>Show activity</Button> : (
        <ul className="audit">{rows.map((r) => <li key={r.id}><span className="muted">{ago(r.ts)}</span> <b>{r.actor}</b> {r.action.replace(/_/g, ' ')}{r.detail?.task ? ` · ${r.detail.task}` : r.detail?.client ? ` · ${r.detail.client}` : ''}</li>)}</ul>
      )}
    </Details>
  );
}

export function Settings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { void api('GET', '/api/settings').then(setS).catch((e) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  useEffect(() => { if (s && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, [s]);
  if (err) return <ErrorNote>{err}</ErrorNote>;
  if (!s) return <Spinner />;
  const c = claudeSummary(s.claude);
  return (
    <>
      <h1>Settings</h1>
      <Section id="claude" title="Claude">
        <p className={`status-line ${c.ok ? 'ok' : 'bad'}`}><i className="dot" />{c.text}</p>
        {s.claude.expired && <p className="note error">Your Claude token expired. Reconnect to let tasks run again.</p>}
        {s.admin ? <ClaudeConnect status={s.claude} onChange={load} /> : <p className="muted">Ask an administrator to manage this.</p>}
        {s.admin && s.claude.connected && <Button variant="ghost" busyLabel="Disconnecting…" onClick={async () => { if (confirm('Disconnect Claude? Running tasks will fail.')) { await api('DELETE', '/api/claude'); load(); } }}>Disconnect</Button>}
      </Section>
      <Projects s={s} />
      <Section id="chat" title="Connect your chat"><ChatConnect mcpUrl={s.mcpUrl} /></Section>
      <Apps s={s} reload={load} />
      <People s={s} reload={load} />
      <Details title="More settings">
        <Defaults s={s} reload={load} />
        {s.admin && <Domain s={s} />}
      </Details>
      <Section id="github" title="GitHub">
        {s.github.configured ? <p>Connected through your private app <b>{s.github.slug}</b>. {s.github.appUrl && <a href={s.github.appUrl} target="_blank" rel="noreferrer">Manage on GitHub</a>}</p> : <p className="note error">GitHub is not connected. Run <code>sudo bivouac reset-admin</code> on the server and follow the link.</p>}
      </Section>
      {s.admin && <VersionSection version={s.version} />}
      {s.admin && <Activity />}
    </>
  );
}

export function ConnectPage({ mcpUrl }: { mcpUrl: string }) {
  return (
    <>
      <h1>Connect your chat</h1>
      <p className="muted">Once connected, ask Claude or ChatGPT to start and follow tasks. This page only follows, stops and configures them.</p>
      <section className="card"><ChatConnect mcpUrl={mcpUrl} /></section>
    </>
  );
}
