import { useEffect, useRef } from 'react';
import { CheckCircle2, ExternalLink, Wrench, XCircle } from 'lucide-react';
import { EmptyState } from './misc';
import { summarize, type Item } from '@/lib/task-items';
import { cn } from '@/lib/utils';

const Pre = ({ children, className }: { children: string; className?: string }) => (
  <pre className={cn('max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words', className)}>{children}</pre>
);

/** The readable feed of what the agent said, what was checked and which tools it used. Keeps the end in view while following. */
export function TaskFeed({ items, follow }: { items: Item[]; follow: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // never yank the page on the first paint; afterwards only while the task is active
    if (first.current) { first.current = false; return; }
    if (follow) end.current?.scrollIntoView({ block: 'nearest' });
  }, [items.length, follow]);
  if (!items.length) return <EmptyState title="Nothing yet">The agent’s messages, checks and tool calls appear here as it works.</EmptyState>;
  return (
    <>
      <ol className="space-y-3">
        {items.map((it) => {
          switch (it.kind) {
            case 'say': return <li key={it.id} className={cn('whitespace-pre-wrap break-words text-sm', it.thinking && 'italic text-muted-foreground')}>{it.text}</li>;
            case 'you': return (
              <li key={it.id} className="rounded-md border-l-2 border-primary bg-muted/50 px-3 py-2 text-sm">
                <b>You</b> <span className="whitespace-pre-wrap break-words">{it.text}</span>
                {it.queued && <span className="text-muted-foreground"> · will be applied at the next attempt</span>}
              </li>
            );
            case 'tools': return (
              <li key={it.id}>
                <details className="group rounded-md border">
                  <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm text-muted-foreground sm:min-h-9"><Wrench className="size-4" aria-hidden="true" />{it.calls.length === 1 ? `Used ${it.calls[0].name}` : `Used ${it.calls.length} tools`}</summary>
                  <div className="space-y-1 border-t p-2">
                    {it.calls.map((c, i) => (
                      <details key={i} className="rounded-md">
                        <summary className={cn('min-h-9 cursor-pointer py-1.5 text-xs', c.bad && 'text-red-700 dark:text-red-300')}><b>{c.name}</b> <span className="font-mono text-muted-foreground">{summarize(c.input)}</span></summary>
                        <div className="space-y-1 pb-2"><Pre>{JSON.stringify(c.input, null, 2)}</Pre>{c.result && <Pre>{c.result}</Pre>}</div>
                      </details>
                    ))}
                  </div>
                </details>
              </li>
            );
            case 'check': return (
              <li key={it.id}>
                <details open={!it.ok} className={cn('rounded-md border', it.ok ? 'border-emerald-500/40' : 'border-red-500/40')}>
                  <summary className={cn('flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm sm:min-h-9', it.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
                    {it.ok ? <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" /> : <XCircle className="size-4 shrink-0" aria-hidden="true" />}
                    <span className="shrink-0">{it.ok ? 'Check passed' : `Check failed (code ${it.exitCode})`}</span>
                    <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{it.command}</code>
                  </summary>
                  {it.output.trim() && <div className="border-t p-2"><Pre>{it.output}</Pre></div>}
                </details>
              </li>
            );
            case 'note': return (
              <li key={it.id} className={cn('text-sm', it.bad ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground')}>
                {it.text} {it.href && <a href={it.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">Open<ExternalLink className="size-3" aria-hidden="true" /></a>}
              </li>
            );
          }
        })}
      </ol>
      <div ref={end} />
    </>
  );
}
