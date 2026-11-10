import { useState } from 'react';
import { Globe } from 'lucide-react';
import { api, ApiError } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DnsRecords } from '@/components/app/dns-records';
import { Note } from '@/components/app/misc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { SectionProps } from './types';

interface DomainCheck { ok: boolean; apex: string[]; wildcard: string[]; error?: string }

export function DomainSection({ s }: SectionProps) {
  const [domain, setDomain] = useState('');
  const [check, setCheck] = useState<DomainCheck | null>(null);
  const d = domain.trim().toLowerCase();
  const valid = /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d);

  if (!s.admin) {
    return (
      <div className="space-y-6">
        <Heading />
        <Card><CardContent><p>Your bivouac lives at <b className="break-all">{s.domain}</b>.</p></CardContent></Card>
      </div>
    );
  }

  const runCheck = async () => {
    try {
      setCheck(await api<DomainCheck>('POST', '/api/setup/domain/check', { domain: d }));
    } catch (e) {
      // The check lives in the setup routes, which are only reachable from the setup link.
      const unavailable = !(e instanceof ApiError) || [401, 403, 404].includes(e.status);
      setCheck({ ok: false, apex: [], wildcard: [], error: unavailable ? 'Setup tools are only available from the setup link. Run “sudo bivouac reset-admin” on the server to get one, then try again.' : (e as Error).message });
    }
  };

  return (
    <div className="space-y-6">
      <Heading />
      <Card>
        <CardHeader>
          <CardTitle>Current address</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <p>Your bivouac lives at <b className="break-all">{s.domain}</b>.</p>
          {s.sslip && <p className="text-sm text-muted-foreground">This is a temporary address based on your server’s IP. Use your own domain for a permanent one.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Use my own domain</CardTitle>
          <CardDescription>Point a domain you own at this server, check the records, then switch.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="own-domain">Domain</Label>
            <Input id="own-domain" placeholder="bv.example.com" value={domain} autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onChange={(e) => { setDomain(e.target.value); setCheck(null); }} />
          </div>
          {d.includes('.') && <DnsRecords domain={d} ip={s.publicIp} />}
          {check && !check.ok && <Note tone="warn">{check.error ?? 'The records are not visible yet. DNS can take a few minutes: wait a little, then check again.'}</Note>}
          {check?.ok && <Note tone="ok">The DNS records are in place for {d}.</Note>}
          <AsyncButton busyLabel="Checking the DNS records…" disabled={!valid} className="h-11 sm:h-9" onClick={runCheck}>Check the DNS records</AsyncButton>
        </CardContent>
      </Card>
      {check?.ok && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">Danger zone</CardTitle>
            <CardDescription>Switching domain recreates the GitHub connection and disconnects your chat connectors. You will reconnect them afterwards.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ConfirmDialog
              trigger={<AsyncButton variant="destructive" className="h-11 sm:h-9"><Globe />Switch to {d}</AsyncButton>}
              title={`Switch to ${d}?`}
              description="bivouac will move to the new address and recreate its GitHub connection. Chat connectors are disconnected: add the new address to Claude or ChatGPT afterwards. The old address stops working."
              confirmLabel={`Switch to ${d}`} busyLabel="Switching…"
              onConfirm={async () => { const r = await api<{ redirect: string }>('POST', '/api/settings/domain', { domain: d }); location.href = r.redirect; await new Promise(() => {}); }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const Heading = () => (
  <div>
    <h2 className="text-lg font-semibold">Address</h2>
    <p className="text-sm text-muted-foreground">Where your bivouac lives on the internet.</p>
  </div>
);
