import { useState, type ReactNode } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { CopyField } from '@/components/app/misc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { SectionProps } from './types';

const UPDATE_SOURCE = 'https://github.com/harijoe/bivouac/releases';

function Block({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="h-12 w-full justify-between px-4 sm:h-11" aria-expanded={open}>
            {title}<ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent><CardContent className="space-y-3 pb-4 text-sm">{children}</CardContent></CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><span className="text-muted-foreground">{label}</span><span className="min-w-0 break-all font-mono text-xs">{children}</span></div>
);

export function AdvancedSection({ s }: SectionProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Advanced</h2>
        <p className="text-sm text-muted-foreground">Technical details for support or troubleshooting. You never need these day to day.</p>
      </div>
      <div className="space-y-3">
        <Block title="Installation">
          <Row label="Version">{s.version}</Row>
          <Row label="Public IP">{s.publicIp ?? 'unknown'}</Row>
          <Row label="Address">{s.baseUrl}</Row>
        </Block>
        <Block title="Chat connection (MCP)">
          <CopyField label="MCP address" value={s.mcpUrl} />
        </Block>
        <Block title="GitHub App">
          {s.github.configured ? (
            <>
              <Row label="App name">{s.github.slug}</Row>
              {s.github.appUrl && <a href={s.github.appUrl} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 underline underline-offset-2 sm:min-h-0">Manage the app on GitHub<ExternalLink className="size-3.5" aria-hidden="true" /></a>}
            </>
          ) : <p className="text-muted-foreground">GitHub is not connected. Run <code className="font-mono">sudo bivouac reset-admin</code> on the server and follow the link.</p>}
        </Block>
        {s.admin && (
          <Block title="OAuth redirect allow-list">
            <p className="text-muted-foreground">After sign-in, chat apps can only send you back to these addresses.</p>
            {s.redirectAllow.length === 0 ? <p className="text-muted-foreground">None configured.</p> : <ul className="space-y-1">{s.redirectAllow.map((h) => <li key={h} className="break-all font-mono text-xs">{h}</li>)}</ul>}
          </Block>
        )}
        <Block title="Update source">
          <p className="text-muted-foreground">New versions and release notes come from GitHub releases.</p>
          <a href={UPDATE_SOURCE} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 break-all underline underline-offset-2 sm:min-h-0">{UPDATE_SOURCE}<ExternalLink className="size-3.5 shrink-0" aria-hidden="true" /></a>
        </Block>
      </div>
    </div>
  );
}
