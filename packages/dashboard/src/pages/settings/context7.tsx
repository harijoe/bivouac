import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import { AsyncButton } from '@/components/app/async-button';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { ErrorNote } from '@/components/app/misc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAsync } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { SectionProps } from './types';

export function Context7Section({ s, reload }: SectionProps) {
  const [key, setKey] = useState('');
  const a = useAsync();
  const configured = s.context7.configured;
  const save = () => a.run(async () => {
    await api('PUT', '/api/settings/context7', { apiKey: key.trim() });
    toast.success('Context7 key saved');
    setKey('');
    reload();
  });
  return (
    <div className="space-y-6">
      <div className="max-w-2xl space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Context7</h2>
          <Badge variant="outline" className={cn('font-medium', configured ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-muted text-muted-foreground')}>
            {configured ? 'API key configured' : 'No API key'}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">Context7 gives the agent up-to-date library documentation. It works without a key: the key only raises the rate limits. It is stored encrypted and never shown again.</p>
      </div>
      <form className="max-w-xl space-y-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="space-y-1.5">
          <Label htmlFor="context7-key">{configured ? 'Replace the API key' : 'API key (optional)'}</Label>
          <Input id="context7-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} maxLength={500}
            placeholder={configured ? 'New API key' : 'ctx7sk-…'} className="h-11 font-mono sm:h-9" />
        </div>
        <ErrorNote>{a.error}</ErrorNote>
        <div className="flex flex-wrap gap-2">
          <AsyncButton type="submit" className="h-11 sm:h-9" busy={a.busy} busyLabel="Saving…" disabled={!key.trim()}>{configured ? 'Replace key' : 'Save key'}</AsyncButton>
          {configured && (
            <ConfirmDialog
              trigger={<Button type="button" variant="outline" className="h-11 sm:h-9" disabled={a.busy}><Trash2 />Remove key</Button>}
              title="Remove the Context7 key?" confirmLabel="Remove key" busyLabel="Removing…"
              description="Context7 keeps working without a key, with lower rate limits."
              onConfirm={async () => { await api('DELETE', '/api/settings/context7'); toast.success('Context7 key removed'); reload(); }}
            />
          )}
        </div>
      </form>
    </div>
  );
}
