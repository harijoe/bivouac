import type { TaskEvent } from '@/api';

export interface ToolCall { name: string; input: any; result?: string; bad?: boolean }
export type Item =
  | { kind: 'say'; id: number; text: string; thinking?: boolean }
  | { kind: 'you'; id: number; text: string; queued?: boolean }
  | { kind: 'tools'; id: number; calls: ToolCall[] }
  | { kind: 'check'; id: number; ok: boolean; command: string; output: string; exitCode: number }
  | { kind: 'note'; id: number; text: string; bad?: boolean; href?: string };

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
