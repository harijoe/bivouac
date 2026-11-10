import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Progress of the first-run wizard: numbered dots on mobile (with the current label), full labels from `sm`. */
export function SetupStepper({ steps, current }: { steps: readonly { id: string; label: string }[]; current: string }) {
  const at = steps.findIndex((s) => s.id === current);
  return (
    <div className="mb-6">
      <ol className="flex items-center" aria-label="Progress">
        {steps.map((s, i) => {
          const done = i < at, on = i === at;
          return (
            <li key={s.id} className={cn('flex items-center', i < steps.length - 1 && 'flex-1')} aria-current={on ? 'step' : undefined}>
              <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium', done && 'border-primary bg-primary text-primary-foreground', on && 'border-primary text-foreground ring-2 ring-primary/30', !done && !on && 'text-muted-foreground')}>
                {done ? <Check className="size-4" aria-label="Done" /> : i + 1}
              </span>
              <span className={cn('ml-2 hidden text-sm sm:inline', on ? 'font-medium' : 'text-muted-foreground')}>{s.label}</span>
              {i < steps.length - 1 && <span className={cn('mx-2 h-px min-w-3 flex-1', done ? 'bg-primary' : 'bg-border')} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-sm text-muted-foreground sm:hidden">Step {at + 1} of {steps.length}: <b className="text-foreground">{steps[at]?.label}</b></p>
    </div>
  );
}
