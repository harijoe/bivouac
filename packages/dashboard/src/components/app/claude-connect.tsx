import { useEffect, useRef, useState } from 'react';
import { ExternalLink, KeyRound, Loader2, UserRound } from 'lucide-react';
import { api } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ErrorNote, Note } from '@/components/app/misc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAsync } from '@/lib/hooks';

type Phase = 'starting' | 'waiting_code' | 'verifying' | 'done' | 'error';
interface LoginState { phase: Phase; url?: string | null; message?: string | null }

/** Short explanation of the two ways to sign in and what the amounts mean. */
export function ClaudeHelp() {
  return (
    <p className="text-sm text-muted-foreground">
      <b className="text-foreground">Subscription</b>: tasks use your Claude plan, and the amounts shown are an estimated API equivalent, not money spent.{' '}
      <b className="text-foreground">API key</b>: pay-as-you-go billing through the Anthropic API. In both cases the dollar limit per task is a safeguard on consumption.
    </p>
  );
}

/**
 * Adds a Claude account (subscription sign-in guided, or API key), or renews one when `accountId` is given.
 * `kind` limits the choice when renewing. The daemon stores the token itself when the sign-in ends.
 */
export function ClaudeConnect({ onDone, accountId, kind, defaultName = '', onCancel }: {
  onDone: () => void; accountId?: number; kind?: 'oauth' | 'apikey'; defaultName?: string; onCancel?: () => void;
}) {
  const renewing = accountId !== undefined;
  const [name, setName] = useState(defaultName);
  const [method, setMethod] = useState<'oauth' | 'apikey'>(kind ?? 'oauth');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginState>({ phase: 'starting' });
  const [code, setCode] = useState('');
  const [key, setKey] = useState('');
  const start = useAsync();
  const send = useAsync();
  const save = useAsync();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const poll = async () => {
      try {
        const s = await api<LoginState>('GET', `/api/claude/login/${sessionId}`);
        if (!live) return;
        setLogin({ phase: s.phase, url: s.url ?? null, message: s.message ?? '' });
        if (s.phase === 'done') { clearInterval(timer); doneRef.current(); }
        else if (s.phase === 'error') clearInterval(timer);
      } catch (e) {
        if (!live) return;
        clearInterval(timer);
        setLogin({ phase: 'error', message: (e as Error).message });
      }
    };
    const timer = setInterval(poll, 1200);
    void poll();
    return () => { live = false; clearInterval(timer); };
  }, [sessionId]);

  const trimmed = name.trim();
  const nameOk = renewing || trimmed.length > 0;
  const begin = () => start.run(async () => {
    setLogin({ phase: 'starting' });
    const r = await api<{ id: string }>('POST', '/api/claude/login', renewing ? { accountId } : { name: trimmed });
    setSessionId(r.id);
  });
  const cancel = () => {
    if (sessionId) void api('DELETE', `/api/claude/login/${sessionId}`).catch(() => {});
    setSessionId(null); setCode(''); setLogin({ phase: 'starting' });
    onCancel?.();
  };
  const startOver = async () => {
    if (sessionId) void api('DELETE', `/api/claude/login/${sessionId}`).catch(() => {});
    setSessionId(null); setCode('');
    await begin();
  };

  const nameField = !renewing && (
    <div className="space-y-1.5">
      <Label htmlFor="claude-account-name">Account name</Label>
      <Input id="claude-account-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Personal, Work…" maxLength={60} autoComplete="off" disabled={!!sessionId} />
    </div>
  );

  // ---- guided sign-in in progress
  if (sessionId) {
    const verifying = login.phase === 'verifying';
    return (
      <div className="space-y-4">
        {login.phase === 'starting' && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Preparing the sign-in…</p>}
        {(login.phase === 'waiting_code' || verifying) && login.url && (
          <>
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li><b>Open the sign-in page</b> and approve access with your Claude account.
                <div className="mt-2"><Button asChild size="lg" className="h-11 sm:h-9"><a href={login.url} target="_blank" rel="noreferrer"><ExternalLink />Open claude.ai</a></Button></div>
              </li>
              <li><b>Copy the code</b> shown at the end, and paste it here.</li>
            </ol>
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send.run(async () => { await api('POST', `/api/claude/login/${sessionId}/code`, { code: code.trim() }); setLogin((l) => ({ ...l, phase: 'verifying' })); }); }}>
              <Label htmlFor="claude-code">Sign-in code</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input id="claude-code" autoFocus autoComplete="off" spellCheck={false} placeholder="Paste the code here" value={code} readOnly={verifying} onChange={(e) => setCode(e.target.value)} className="font-mono" />
                <AsyncButton type="submit" size="lg" className="h-11 shrink-0 sm:h-9" disabled={!code.trim()} busy={send.busy || verifying} busyLabel="Verifying the code…">Continue</AsyncButton>
              </div>
              {verifying && <p className="text-sm text-muted-foreground" role="status">Claude is checking the code. This takes a few seconds.</p>}
              <ErrorNote>{send.error}</ErrorNote>
            </form>
          </>
        )}
        {login.phase === 'done' && <Note tone="ok">Claude is connected.</Note>}
        {login.phase === 'error' && <Note tone="error" title="The sign-in did not finish">{login.message || 'Something went wrong.'} Click “Start over” to get a new sign-in page and a new code.</Note>}
        <ErrorNote>{start.error}</ErrorNote>
        <div className="flex flex-wrap gap-2">
          {login.phase === 'error' && <AsyncButton size="lg" className="h-11 sm:h-9" busyLabel="Opening the sign-in…" onClick={startOver}>Start over</AsyncButton>}
          {login.phase !== 'done' && !verifying && <Button variant="ghost" className="h-11 sm:h-9" onClick={cancel}>Cancel</Button>}
        </div>
      </div>
    );
  }

  // ---- choose how to connect
  const saveKey = () => save.run(async () => {
    if (renewing) await api('PUT', `/api/claude/accounts/${accountId}/apikey`, { key: key.trim() });
    else await api('POST', '/api/claude/accounts', { name: trimmed, key: key.trim() });
    setKey('');
    onDone();
  });
  const subscription = (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">You sign in on claude.ai, copy a code and paste it here. It takes a minute.</p>
      <ErrorNote>{start.error}</ErrorNote>
      <div className="flex flex-wrap gap-2">
        <AsyncButton size="lg" className="h-11 sm:h-9" disabled={!nameOk} busyLabel="Opening the sign-in…" onClick={begin}>{renewing ? 'Renew the sign-in' : 'Sign in with Claude'}</AsyncButton>
        {onCancel && <Button variant="ghost" className="h-11 sm:h-9" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
  const apikey = (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void saveKey(); }}>
      <div className="space-y-1.5">
        <Label htmlFor="claude-api-key">API key</Label>
        <Input id="claude-api-key" type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" />
        <p className="text-xs text-muted-foreground">Pay-as-you-go billing through the Anthropic API. The key starts with <code className="font-mono">sk-ant-</code>; it is checked before it is saved.</p>
      </div>
      <ErrorNote>{save.error}</ErrorNote>
      <div className="flex flex-wrap gap-2">
        <AsyncButton type="submit" size="lg" className="h-11 sm:h-9" disabled={!key.trim() || !nameOk} busy={save.busy} busyLabel="Checking the key…">Save key</AsyncButton>
        {onCancel && <Button type="button" variant="ghost" className="h-11 sm:h-9" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
  return (
    <div className="space-y-4">
      {nameField}
      {kind ? (kind === 'oauth' ? subscription : apikey) : (
        <Tabs value={method} onValueChange={(v) => setMethod(v as 'oauth' | 'apikey')}>
          <TabsList className="w-full">
            <TabsTrigger value="oauth"><UserRound />Subscription</TabsTrigger>
            <TabsTrigger value="apikey"><KeyRound />API key</TabsTrigger>
          </TabsList>
          <TabsContent value="oauth" className="pt-3">{subscription}</TabsContent>
          <TabsContent value="apikey" className="pt-3">{apikey}</TabsContent>
        </Tabs>
      )}
    </div>
  );
}
