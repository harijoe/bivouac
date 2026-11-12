import { Camera, CheckCircle2, ExternalLink, GitCommitHorizontal, Link2, Link2Off, RotateCw, ServerOff, Wrench, XCircle, type LucideIcon } from 'lucide-react';
import { Hl, useQuery } from './highlight';
import { summarize, type Item, type NoteIcon, type NoteTone } from '@/lib/task-items';
import { cn } from '@/lib/utils';

const Pre = ({ children, className }: { children: string; className?: string }) => (
  <pre className={cn('max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words', className)}><Hl>{children}</Hl></pre>
);
const NOTE_ICON: Record<NoteIcon, LucideIcon> = { down: ServerOff, restart: RotateCw, recovered: CheckCircle2, camera: Camera, link: Link2, unlink: Link2Off, mark: GitCommitHorizontal };
const NOTE_TONE: Record<NoteTone, string> = { warn: 'text-amber-700 dark:text-amber-300', ok: 'text-emerald-700 dark:text-emerald-300', info: 'text-muted-foreground' };
const has = (q: string, ...texts: (string | undefined)[]) => q.trim().length >= 2 && texts.some((t) => (t ?? '').toLowerCase().includes(q.trim().toLowerCase()));

/** What the agent said, what was checked and which tools it used, in the order it happened. Tool calls are folded away. */
export function FeedList({ items }: { items: Item[] }) {
  const q = useQuery();
  return (
    <ol className="space-y-3">
      {items.map((it) => {
        switch (it.kind) {
          case 'say': return <li key={it.id} className={cn('whitespace-pre-wrap break-words text-sm', it.thinking && 'italic text-muted-foreground')}><Hl>{it.text}</Hl></li>;
          case 'you': return (
            <li key={it.id} className="rounded-md border-l-2 border-primary bg-muted/50 px-3 py-2 text-sm">
              <b>You</b> <span className="whitespace-pre-wrap break-words"><Hl>{it.text}</Hl></span>
              {it.queued && <span className="text-muted-foreground"> · will be applied at the next attempt</span>}
            </li>
          );
          case 'tools': {
            const hit = it.calls.some((c) => has(q, c.name, JSON.stringify(c.input), c.result));
            return (
              <li key={it.id}>
                <details open={hit || undefined} className="group rounded-md border">
                  <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm text-muted-foreground sm:min-h-9"><Wrench className="size-4" aria-hidden="true" />{it.calls.length === 1 ? `Used ${it.calls[0].name}` : `Used ${it.calls.length} tools`}</summary>
                  <div className="space-y-1 border-t p-2">
                    {it.calls.map((c, i) => (
                      <details key={i} open={has(q, c.name, JSON.stringify(c.input), c.result) || undefined} className="rounded-md">
                        <summary className={cn('min-h-9 cursor-pointer py-1.5 text-xs', c.bad && 'text-red-700 dark:text-red-300')}><b>{c.name}</b> <span className="font-mono text-muted-foreground"><Hl>{summarize(c.input)}</Hl></span></summary>
                        <div className="space-y-1 pb-2"><Pre>{JSON.stringify(c.input, null, 2)}</Pre>{c.result && <Pre>{c.result}</Pre>}</div>
                      </details>
                    ))}
                  </div>
                </details>
              </li>
            );
          }
          case 'check': return (
            <li key={it.id}>
              <details open={!it.ok || has(q, it.command, it.output) || undefined} className={cn('rounded-md border', it.ok ? 'border-emerald-500/40' : 'border-red-500/40')}>
                <summary className={cn('flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm sm:min-h-9', it.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
                  {it.ok ? <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" /> : <XCircle className="size-4 shrink-0" aria-hidden="true" />}
                  <span className="shrink-0">{it.ok ? 'Check passed' : `Check failed (code ${it.exitCode})`}</span>
                  <code className="min-w-0 truncate font-mono text-xs text-muted-foreground"><Hl>{it.command}</Hl></code>
                </summary>
                {it.output.trim() && <div className="border-t p-2"><Pre>{it.output}</Pre></div>}
              </details>
            </li>
          );
          case 'note': {
            const Icon = it.icon ? NOTE_ICON[it.icon] : null;
            return (
            <li key={it.id} className={cn('text-sm', it.bad ? 'text-red-700 dark:text-red-300' : NOTE_TONE[it.tone ?? 'info'], Icon && 'flex items-start gap-2')}>
              {Icon && <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 break-words"><Hl>{it.text}</Hl> {it.href && <a href={it.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">Open<ExternalLink className="size-3" aria-hidden="true" /></a>}</span>
            </li>
            );
          }
        }
      })}
    </ol>
  );
}
