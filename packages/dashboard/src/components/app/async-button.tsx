import { useEffect, useRef, useState, type ComponentProps, type MouseEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  /** Shown while waiting, e.g. "Verifying the code…". Always give one. */
  busyLabel?: string;
  /** Force the busy state (forms); a click handler that returns a promise is tracked automatically. */
  busy?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
};

/**
 * The button of every action that waits for an answer: spinner + explicit label while it waits, disabled meanwhile, and
 * therefore never clicked twice. Return the promise from `onClick` (or pass `busy`) and nothing else is needed.
 */
export function AsyncButton({ busy, busyLabel, onClick, children, disabled, ...props }: Props) {
  const [own, setOwn] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const waiting = !!busy || own;
  const click = onClick && (async (e: MouseEvent<HTMLButtonElement>) => {
    const r = onClick(e);
    if (r instanceof Promise) { setOwn(true); try { await r; } finally { if (alive.current) setOwn(false); } }
  });
  return (
    <Button {...props} onClick={click} disabled={disabled || waiting} aria-busy={waiting || undefined}>
      {waiting ? <><Loader2 className="animate-spin" aria-hidden="true" />{busyLabel ?? 'Please wait…'}</> : children}
    </Button>
  );
}
