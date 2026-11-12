import type { TaskEvent } from '@/api';

export interface ToolCall { name: string; input: any; result?: string; bad?: boolean }
export type Item =
  | { kind: 'say'; id: number; text: string; thinking?: boolean }
  | { kind: 'you'; id: number; text: string; queued?: boolean }
  | { kind: 'tools'; id: number; calls: ToolCall[] }
  | { kind: 'check'; id: number; ok: boolean; command: string; output: string; exitCode: number }
  | { kind: 'note'; id: number; text: string; bad?: boolean; href?: string; tone?: NoteTone; icon?: NoteIcon };
export type NoteTone = 'warn' | 'ok' | 'info';
export type NoteIcon = 'down' | 'restart' | 'recovered' | 'camera' | 'link' | 'unlink' | 'mark';

/** One-liners for the system events of the preview, screenshots, alias and git marks: a sentence, an icon and a tone. */
export function systemNote(d: any): { text: string; tone: NoteTone; icon: NoteIcon } | null {
  const msg = (fallback: string) => (String(d?.message ?? '').trim() || fallback);
  switch (d?.subtype) {
    case 'preview_down': return { text: msg('The preview stopped answering.'), tone: 'warn', icon: 'down' };
    case 'preview_restarting': return { text: msg('Restarting the preview.'), tone: 'info', icon: 'restart' };
    case 'preview_gave_up': return { text: msg('bivouac gave up restarting the preview.'), tone: 'warn', icon: 'down' };
    case 'preview_recovered': return { text: msg('The preview is back.'), tone: 'ok', icon: 'recovered' };
    case 'preview_restart_requested': return { text: msg('A restart of the preview was requested.'), tone: 'info', icon: 'restart' };
    case 'screenshots': {
      const problems = Number(d.problems ?? 0);
      const bad = d.ok === false || problems > 0;
      const fallback = d.ok === false ? 'Screenshots could not be taken.' : `${Number(d.count ?? 0)} screenshots taken${problems ? `, ${problems} with problems` : ''}.`;
      return { text: msg(fallback), tone: bad ? 'warn' : 'info', icon: 'camera' };
    }
    case 'alias_assigned': return { text: msg('The stable address now points to this task.'), tone: 'info', icon: 'link' };
    case 'alias_released': return { text: msg('The stable address no longer points to this task.'), tone: 'info', icon: 'unlink' };
    case 'mark_failed': return { text: msg('The git mark of this attempt could not be recorded.'), tone: 'warn', icon: 'mark' };
    default: return null;
  }
}

export const summarize = (i: any) => String(i?.command ?? i?.file_path ?? i?.pattern ?? i?.path ?? (i ? JSON.stringify(i) : '')).slice(0, 90);

/** Turns the raw event stream into a short, readable feed: what was said, what was checked, and tool calls folded away. */
export function toItems(events: TaskEvent[]): Item[] {
  const out: Item[] = [];
  const pending = new Map<string, ToolCall>();
  const lastTools = () => { const l = out[out.length - 1]; return l?.kind === 'tools' ? l : null; };
  for (const e of events) {
    const d = e.data;
    switch (e.kind) {
      case 'assistant_text': if (String(d.text ?? '').trim()) out.push({ kind: 'say', id: e.id, text: d.text, thinking: d.thinking }); break;
      case 'tool_use': {
        const call: ToolCall = { name: d.name, input: d.input };
        pending.set(d.id ?? String(e.id), call);
        const g = lastTools();
        if (g) g.calls.push(call); else out.push({ kind: 'tools', id: e.id, calls: [call] });
        break;
      }
      case 'tool_result': { const c = pending.get(d.toolUseId ?? d.id); if (c) { c.result = String(d.text ?? ''); c.bad = !!d.isError; } break; }
      case 'user_instruction': out.push({ kind: 'you', id: e.id, text: d.text, queued: d.queued }); break;
      case 'check': out.push({ kind: 'check', id: e.id, ok: d.exitCode === 0, command: d.command, output: String(d.output ?? ''), exitCode: d.exitCode }); break;
      case 'error': out.push({ kind: 'note', id: e.id, text: d.message, bad: true }); break;
      case 'system':
        if (d.subtype === 'push') out.push({ kind: 'note', id: e.id, text: `Branch ${d.branch} pushed to GitHub.` });
        else if (d.subtype === 'pr') out.push({ kind: 'note', id: e.id, text: 'Pull request opened.', href: d.url });
        else if (d.subtype === 'config_warning') out.push({ kind: 'note', id: e.id, text: d.message, bad: true });
        else if (d.subtype === 'service_incident') out.push({ kind: 'note', id: e.id, text: String(d.message ?? ''), bad: true });
        else { const n = systemNote(d); if (n) out.push({ kind: 'note', id: e.id, ...n }); }
        break;
      default: break;
    }
  }
  return out;
}

/** Does the error text point at the Claude account / token / usage limit? Then the page offers to reconnect. */
export const isClaudeProblem = (error: string | null | undefined) => !!error && /claude|token|credential|authenticat|limit|account/i.test(error);

export type Filters = { messages: boolean; checks: boolean; tools: boolean; instructions: boolean };
export const allFilters: Filters = { messages: true, checks: true, tools: true, instructions: true };
/** Filters of the history: agent messages, checks, tool calls, instructions. Notes (push, pull request, problems) always stay. */
export function filterItems(items: Item[], f: Filters): Item[] {
  return items.filter((i) => (i.kind === 'say' ? f.messages : i.kind === 'check' ? f.checks : i.kind === 'tools' ? f.tools : i.kind === 'you' ? f.instructions : true));
}
