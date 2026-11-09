import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, CopyField, Details, ErrorNote, useAsync } from '../ui';

// ---------- Connect Claude (claude setup-token in a throwaway container)
interface ClaudeStatus { connected: boolean; kind: 'oauth' | 'apikey' | null; expiresAt: string | null; expired: boolean }

export function claudeSummary(s: ClaudeStatus | null): { text: string; ok: boolean } {
  if (!s || !s.connected) return { text: 'Not connected', ok: false };
  if (s.expired) return { text: 'Token expired', ok: false };
  if (s.kind === 'apikey') return { text: 'Connected with an API key', ok: true };
  const days = s.expiresAt ? Math.round((Date.parse(s.expiresAt) - Date.now()) / 86400_000) : null;
  return { text: days !== null && days < 400 ? `Connected, valid for ${days > 60 ? `${Math.round(days / 30)} months` : `${days} days`}` : 'Connected', ok: true };
}

export function ClaudeConnect({ status, onChange, primaryLabel }: { status: ClaudeStatus | null; onChange: () => void; primaryLabel?: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'starting' | 'waiting_code' | 'verifying' | 'done' | 'error'>('starting');
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const [key, setKey] = useState('');
  const a = useAsync();
  const timer = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!sessionId) return;
    const poll = async () => {
      try {
        const s = await api('GET', `/api/claude/login/${sessionId}`);
        setPhase(s.phase); setUrl(s.url ?? null); setMessage(s.message ?? '');
        if (s.phase === 'done') { clearInterval(timer.current); setSessionId(null); onChange(); }
        if (s.phase === 'error') clearInterval(timer.current);
      } catch (e) { setPhase('error'); setMessage((e as Error).message); clearInterval(timer.current); }
    };
    void poll();
    timer.current = setInterval(poll, 1200);
    return () => clearInterval(timer.current);
  }, [sessionId, onChange]);

  const start = () => a.run(async () => { setPhase('starting'); setUrl(null); setCode(''); setMessage(''); setSessionId((await api('POST', '/api/claude/login')).id); });
  const cancel = () => { if (sessionId) void api('DELETE', `/api/claude/login/${sessionId}`).catch(() => {}); setSessionId(null); setPhase('starting'); };
  const label = primaryLabel ?? (status?.connected ? 'Renew' : 'Connect Claude');

  if (!sessionId && phase !== 'error') {
    return (
      <div className="stack">
        <Button variant={status?.connected && !status.expired ? 'secondary' : 'primary'} onClick={start} busy={a.busy} busyLabel="Opening the sign-in…">{label}</Button>
        <ErrorNote>{a.error}</ErrorNote>
        <Details title="Use an API key instead">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('PUT', '/api/claude/apikey', { key }); setKey(''); onChange(); }); }}>
            <p className="muted">Pay-as-you-go billing through the Anthropic API. Paste a key that starts with <code>sk-ant-</code>.</p>
            <input type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
            <Button disabled={!key} busy={a.busy} busyLabel="Checking the key…">Save key</Button>
          </form>
        </Details>
      </div>
    );
  }
  return (
    <div className="stack">
      {phase === 'starting' && <p className="muted">Preparing the sign-in…</p>}
      {(phase === 'waiting_code' || phase === 'verifying') && url && (
        <>
          <ol className="steps">
            <li><b>Open the sign-in page</b> and approve access with your Claude account.<br /><a className="btn primary inline" href={url} target="_blank" rel="noreferrer">Open claude.ai</a></li>
            <li><b>Copy the code</b> shown at the end, and paste it here.</li>
          </ol>
          <form className="copy-row" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('POST', `/api/claude/login/${sessionId}/code`, { code: code.trim() }); setPhase('verifying'); }); }}>
            <input autoFocus autoComplete="off" placeholder="Paste the code here" aria-label="Sign-in code" value={code} readOnly={phase === 'verifying'} onChange={(e) => setCode(e.target.value)} />
            <Button variant="primary" disabled={!code.trim() && phase !== 'verifying'} busy={a.busy || phase === 'verifying'} busyLabel="Verifying the code…">Continue</Button>
          </form>
          {phase === 'verifying' && <p className="muted" role="status">Claude is checking the code. This takes a few seconds.</p>}
          <ErrorNote>{a.error}</ErrorNote>
        </>
      )}
      {phase === 'error' && (
        <>
          <ErrorNote>{message || 'The sign-in did not finish.'} Click “Start over” to get a new sign-in page and a new code.</ErrorNote>
        </>
      )}
      {phase === 'error' ? <Button variant="primary" busy={a.busy} busyLabel="Opening the sign-in…" onClick={() => { cancel(); void start(); }}>Start over</Button> : <Button variant="ghost" onClick={cancel}>Cancel</Button>}
    </div>
  );
}

// ---------- Connect your chat (MCP URL and short instructions)
export function ChatConnect({ mcpUrl }: { mcpUrl: string }) {
  const [tab, setTab] = useState<'claude' | 'code' | 'chatgpt'>('claude');
  return (
    <div className="stack">
      <CopyField label="Your bivouac address" value={mcpUrl} />
      <div className="tabs" role="tablist">
        {([['claude', 'Claude'], ['code', 'Claude Code'], ['chatgpt', 'ChatGPT']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'claude' && (
        <ol className="steps">
          <li>On claude.ai (or the desktop app), open <b>Settings → Connectors</b>.</li>
          <li>Choose <b>Add custom connector</b>, paste the address above and confirm.</li>
          <li>Click <b>Connect</b>: sign in with GitHub here, then <b>Allow</b>.</li>
          <li>Ask Claude: <i>“Using bivouac, add a dark mode to my-app.”</i></li>
        </ol>
      )}
      {tab === 'code' && (
        <ol className="steps">
          <li>Run this in your terminal:<br /><CopyField value={`claude mcp add --transport http bivouac ${mcpUrl}`} /></li>
          <li>Start <code>claude</code>, type <code>/mcp</code>, pick <b>bivouac</b> and sign in.</li>
        </ol>
      )}
      {tab === 'chatgpt' && (
        <ol className="steps">
          <li>In ChatGPT, open <b>Settings → Connectors → Advanced</b> and turn on <b>Developer mode</b>.</li>
          <li>Choose <b>Create</b>, paste the address above and select <b>OAuth</b> as the authentication.</li>
          <li>Sign in with GitHub when asked, then <b>Allow</b>.</li>
        </ol>
      )}
    </div>
  );
}
