import { Blocks, BookOpen } from 'lucide-react';
import type { Tooling, ToolingMcp, ToolingSkill } from '@bivouac/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const MCP_STATUS: Record<ToolingMcp['status'], { label: string; cls: string }> = {
  connected: { label: 'Connected', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  configured: { label: 'Configured', cls: 'border-border bg-muted text-muted-foreground' },
  failed: { label: 'Failed', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  skipped: { label: 'Skipped', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
};
const SOURCES: { id: ToolingSkill['source']; label: string }[] = [
  { id: 'image', label: 'Built into the image' },
  { id: 'catalogue', label: 'From the catalogue' },
  { id: 'repository', label: 'From the repository' },
];

export function TaskTooling({ tooling }: { tooling: Tooling | null }) {
  if (!tooling) return null;
  const { mcp, skills } = tooling;
  if (mcp.length === 0 && skills.length === 0) return null;
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="tooling-title">
      <h2 id="tooling-title" className="text-sm font-medium">Agent tools</h2>
      {mcp.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs text-muted-foreground"><Blocks className="size-3.5" aria-hidden="true" />MCP servers</h3>
          <ul className="divide-y rounded-md border">
            {mcp.map((m) => {
              const st = MCP_STATUS[m.status];
              return (
                <li key={m.name} className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-start sm:gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:w-64 sm:shrink-0">
                    <span className="min-w-0 break-all font-mono text-xs font-medium">{m.name}</span>
                    <Badge variant="outline" className={cn('font-medium', st.cls)}>{st.label}</Badge>
                  </div>
                  <p className="min-w-0 break-words text-xs text-muted-foreground">
                    {m.kind === 'builtin' ? 'Built-in' : 'Project'} · {m.transport === 'stdio' ? 'command' : 'HTTP'}
                    {m.note && <span className={cn('block', (m.status === 'failed' || m.status === 'skipped') && 'text-amber-700 dark:text-amber-300')}>{m.note}</span>}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {skills.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs text-muted-foreground"><BookOpen className="size-3.5" aria-hidden="true" />Skills</h3>
          <div className="space-y-2">
            {SOURCES.map((src) => {
              const list = skills.filter((s) => s.source === src.id);
              if (list.length === 0) return null;
              return (
                <div key={src.id} className="space-y-1">
                  <p className="text-xs text-muted-foreground">{src.label}</p>
                  <ul className="space-y-1">
                    {list.map((s) => (
                      <li key={s.name} className="min-w-0 text-sm">
                        <span className="break-all font-mono text-xs font-medium">{s.name}</span>
                        {s.note && <span className="block break-words text-xs text-muted-foreground">{s.note}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
