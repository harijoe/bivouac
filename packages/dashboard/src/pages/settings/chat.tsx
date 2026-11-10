import { Plug } from 'lucide-react';
import { ago, api } from '@/api';
import { ChatConnect } from '@/components/app/chat-connect';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { EmptyState } from '@/components/app/misc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { SectionProps } from './types';

export function ChatSection({ s, reload }: SectionProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Connect your chat</h2>
        <p className="text-sm text-muted-foreground">Once connected, ask Claude or ChatGPT to start and follow tasks from your chat.</p>
      </div>
      <Card>
        <CardContent><ChatConnect mcpUrl={s.mcpUrl} /></CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Connected chat apps</CardTitle>
          <CardDescription>Disconnecting an app signs it out here. It can connect again whenever you want.</CardDescription>
        </CardHeader>
        <CardContent>
          {s.grants.length === 0 ? (
            <EmptyState title="No app connected yet" icon={Plug}>Add the address above to Claude or ChatGPT, then come back to see it here.</EmptyState>
          ) : (
            <ul className="divide-y">
              {s.grants.map((g) => (
                <li key={g.id} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{g.clientName}</p>
                    <p className="text-sm text-muted-foreground">{g.login ? `${g.login} · ` : ''}{g.lastUsedAt ? `used ${ago(g.lastUsedAt)}` : `connected ${ago(g.createdAt)}`}</p>
                  </div>
                  <ConfirmDialog
                    trigger={<Button variant="outline" size="sm" className="h-11 sm:h-8">Disconnect</Button>}
                    title={`Disconnect ${g.clientName}?`}
                    description="This app will no longer be able to start or follow tasks until you connect it again."
                    confirmLabel="Disconnect" busyLabel="Disconnecting…"
                    onConfirm={async () => { await api('DELETE', `/api/settings/grants/${g.id}`); reload(); }}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
