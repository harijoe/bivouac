import { useEffect, type ComponentType } from 'react';
import { api, type Session } from '@/api';
import { Note, PageHeader, PageSkeleton } from '@/components/app/misc';
import { Button } from '@/components/ui/button';
import { Link, navigate } from '@/lib/router';
import { useLoad } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { AccessSection } from './access';
import { AdvancedSection } from './advanced';
import { ChatSection } from './chat';
import { ClaudeSection } from './claude';
import { DomainSection } from './domain';
import { ProjectsSection } from './projects';
import type { SectionProps, SettingsData } from './types';
import { UpdatesSection } from './updates';

interface SectionDef { id: string; label: string; adminOnly?: boolean; component: ComponentType<SectionProps> }
const SECTIONS: SectionDef[] = [
  { id: 'claude', label: 'Claude', component: ClaudeSection },
  { id: 'projects', label: 'Projects', component: ProjectsSection },
  { id: 'chat', label: 'Chat connection', component: ChatSection },
  { id: 'domain', label: 'Address', adminOnly: true, component: DomainSection },
  { id: 'updates', label: 'Updates', adminOnly: true, component: UpdatesSection },
  { id: 'access', label: 'Access & security', component: AccessSection },
  { id: 'advanced', label: 'Advanced', adminOnly: true, component: AdvancedSection },
];

/** The sections a user may open (non-administrators only see what they can use). */
export const visibleSections = (admin: boolean) => SECTIONS.filter((x) => admin || !x.adminOnly);

function SectionNav({ items, current }: { items: SectionDef[]; current: string }) {
  return (
    <nav aria-label="Settings sections" className="md:sticky md:top-20 md:self-start">
      <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 md:mx-0 md:flex-col md:gap-1 md:overflow-visible md:px-0 md:pb-0">
        {items.map((x) => (
          <li key={x.id} className="shrink-0">
            <Link
              to={`/settings/${x.id}`}
              aria-current={x.id === current ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors md:min-h-9 md:rounded-md md:border-transparent md:px-3',
                x.id === current ? 'bg-accent text-accent-foreground md:bg-accent' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >{x.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Settings({ section, session }: { section: string | null; session: Session }) {
  const { data: s, error, reload } = useLoad(() => api<SettingsData>('GET', '/api/settings'));
  const items = visibleSections(s?.admin ?? session.user?.role === 'admin');
  const current = items.find((x) => x.id === section);

  useEffect(() => { if (s && !current) navigate(`/settings/${items[0].id}`, true); }, [s, current, items]);
  useEffect(() => { if (!section) navigate('/settings/claude', true); }, [section]);

  if (error && !s) {
    return (
      <>
        <PageHeader title="Settings" />
        <Note tone="error" title="Settings could not be loaded">{error} <Button variant="link" className="h-auto p-0 text-current underline" onClick={reload}>Try again</Button></Note>
      </>
    );
  }
  if (!s || !current) return <><PageHeader title="Settings" /><PageSkeleton /></>;
  const Section = current.component;
  return (
    <>
      <PageHeader title="Settings" description={current.label} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-10">
        <SectionNav items={visibleSections(s.admin)} current={current.id} />
        <div className="min-w-0" key={current.id}><Section s={s} session={session} reload={reload} /></div>
      </div>
    </>
  );
}
