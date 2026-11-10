import { useState, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { TaskStatus } from '@bivouac/shared';

// ---------- task status: one label and one colour everywhere
type Tone = 'working' | 'done' | 'failed' | 'warn' | 'idle';
export const STATUS: Record<TaskStatus, { label: string; tone: Tone; hint?: string }> = {
  queued: { label: 'Waiting', tone: 'idle' }, starting: { label: 'Starting', tone: 'working' }, running: { label: 'Working', tone: 'working' },
  checking: { label: 'Checking', tone: 'working' }, succeeded: { label: 'Done', tone: 'done' }, failed: { label: 'Failed', tone: 'failed', hint: 'Something went wrong. Check the message below, then resume.' },
  budget_exceeded: { label: 'Budget reached', tone: 'warn', hint: 'The spending limit was reached. Resume to give it a new allowance.' },
  max_iterations: { label: 'Out of attempts', tone: 'warn', hint: 'The agent used all its attempts. Resume to give it more, or send an instruction.' },
  stopped: { label: 'Stopped', tone: 'idle', hint: 'Stopped. Resume to continue where it left off.' },
  blocked: { label: 'Needs you', tone: 'warn', hint: 'The agent cannot continue without you. Read what it needs, answer in a message, then resume.' },
  stuck: { label: 'Stuck', tone: 'warn', hint: 'The same check failed twice with no change to the code, so the task was stopped to save tokens. Send an instruction to give it a new direction.' },
};
const TONE: Record<Tone, string> = {
  working: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  done: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  idle: 'border-border bg-muted text-muted-foreground',
};
export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const s = STATUS[status];
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium', TONE[s.tone], className)}>
      <span className={cn('size-1.5 rounded-full bg-current', s.tone === 'working' && 'animate-pulse')} aria-hidden="true" />{s.label}
    </Badge>
  );
}

// ---------- messages
const NOTE: Record<'error' | 'warn' | 'info' | 'ok', { icon: LucideIcon; cls: string }> = {
  error: { icon: AlertCircle, cls: 'border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300 [&>svg]:text-current' },
  warn: { icon: TriangleAlert, cls: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300 [&>svg]:text-current' },
  info: { icon: Info, cls: '' },
  ok: { icon: Check, cls: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300 [&>svg]:text-current' },
};
/** A message with an icon: errors say what happened and what to do. Renders nothing when there is no content. */
export function Note({ tone = 'info', title, children, className }: { tone?: 'error' | 'warn' | 'info' | 'ok'; title?: ReactNode; children?: ReactNode; className?: string }) {
  if (!children && !title) return null;
  const { icon: Icon, cls } = NOTE[tone];
  return (
    <Alert className={cn(cls, className)} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon />
      {title && <AlertTitle>{title}</AlertTitle>}
      {children && <AlertDescription className="text-current/90">{children}</AlertDescription>}
    </Alert>
  );
}
/** Error line under a form (nothing when empty). */
export const ErrorNote = ({ children }: { children?: ReactNode }) => (children ? <Note tone="error">{children}</Note> : null);

// ---------- layout helpers
export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export function EmptyState({ title, children, icon: Icon, action }: { title: string; children?: ReactNode; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      {Icon && <Icon className="size-8 text-muted-foreground" aria-hidden="true" />}
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
      {action}
    </div>
  );
}
/** Skeleton placeholders for a page while it loads. */
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-4" aria-busy="true" aria-label="Loading"><Skeleton className="h-8 w-1/3" />{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>;
}

// ---------- copy
export function CopyField({ value, label, mono = true }: { value: string; label?: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); } catch { /* clipboard needs https: the field is selectable anyway */ }
    setDone(true); setTimeout(() => setDone(false), 1500);
  };
  return (
    <div className="space-y-1.5">
      {label && <p className="text-sm font-medium">{label}</p>}
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label ?? 'Value'} onFocus={(e) => e.target.select()} className={cn(mono && 'font-mono text-xs')} />
        <Button type="button" variant="secondary" onClick={copy} aria-live="polite" className="shrink-0">{done ? <><Check />Copied</> : <><Copy />Copy</>}</Button>
      </div>
    </div>
  );
}

// ---------- formatting
export { ago, duration, fmtTok, fmtUsd } from '@/api';
