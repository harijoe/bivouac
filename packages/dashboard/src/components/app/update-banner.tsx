import { ArrowUpCircle, Loader2 } from 'lucide-react';
import { Link } from '@/lib/router';
import { useUpdate } from '@/lib/use-update';

/** Discreet banner on every page, shown to administrators only (App decides who): a new version, or an update under way. */
export function UpdateBanner() {
  const { st } = useUpdate();
  if (!st) return null;
  let text: string, cta: string, busy = false;
  if (st.progress?.state === 'running') { text = `Updating to ${st.progress.to}…`; cta = 'See progress'; busy = true; }
  else if (st.scheduled) { text = `The update to ${st.scheduled.version} starts when the running tasks finish.`; cta = 'See details'; }
  else if (st.available) { text = `Version ${st.available.version} is available.`; cta = 'See what’s new'; }
  else return null;
  return (
    <Link to="/settings/updates" className="flex min-h-11 flex-wrap items-center justify-center gap-x-2 rounded-lg border bg-card px-3 py-2 text-sm hover:bg-accent sm:min-h-9">
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ArrowUpCircle className="size-4 text-primary" aria-hidden="true" />}
      <span>{text}</span><span className="font-medium underline underline-offset-2">{cta}</span>
    </Link>
  );
}
