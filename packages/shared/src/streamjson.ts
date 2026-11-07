import type { EventKind, Usage } from './types.js';

export interface ParsedEvent {
  kind: EventKind;
  data: any;
  sessionId?: string;
  /** Per-message usage (live estimate, deduplicated by messageId by the caller). */
  messageUsage?: { messageId: string; usage: Omit<Usage, 'costUsd'> };
  /** Authoritative totals for the whole `claude` invocation. */
  result?: { usage: Usage; isError: boolean; subtype: string; text: string; numTurns?: number };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function usageFromRaw(u: any): Omit<Usage, 'costUsd'> {
  return {
    inputTokens: num(u?.input_tokens),
    outputTokens: num(u?.output_tokens),
    cacheReadTokens: num(u?.cache_read_input_tokens),
    cacheCreationTokens: num(u?.cache_creation_input_tokens),
  };
}

function truncate(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return JSON.stringify(content ?? '');
}

/** Parse one line of `claude --output-format stream-json` into zero or more normalized events. */
export function parseStreamLine(line: string): ParsedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let j: any;
  try {
    j = JSON.parse(trimmed);
  } catch {
    return [{ kind: 'system', data: { raw: truncate(trimmed, 500), unparsed: true } }];
  }
  const sessionId: string | undefined = typeof j.session_id === 'string' ? j.session_id : undefined;
  const out: ParsedEvent[] = [];
  switch (j.type) {
    case 'system':
      out.push({ kind: 'system', sessionId, data: { subtype: j.subtype, model: j.model, cwd: j.cwd, tools: Array.isArray(j.tools) ? j.tools.length : undefined } });
      break;
    case 'assistant': {
      const msg = j.message ?? {};
      const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) out.push({ kind: 'assistant_text', sessionId, data: { text: b.text } });
        else if (b.type === 'tool_use') out.push({ kind: 'tool_use', sessionId, data: { id: b.id, name: b.name, input: b.input } });
        else if (b.type === 'thinking' && b.thinking) out.push({ kind: 'assistant_text', sessionId, data: { text: b.thinking, thinking: true } });
      }
      if (msg.id && msg.usage) {
        const mu = { messageId: msg.id as string, usage: usageFromRaw(msg.usage) };
        if (out.length) out[out.length - 1].messageUsage = mu;
        else out.push({ kind: 'system', sessionId, data: { subtype: 'usage' }, messageUsage: mu });
      }
      break;
    }
    case 'user': {
      const blocks: any[] = Array.isArray(j.message?.content) ? j.message.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ kind: 'tool_result', sessionId, data: { toolUseId: b.tool_use_id, isError: !!b.is_error, text: truncate(toolResultText(b.content)) } });
      }
      break;
    }
    case 'rate_limit_event':
      out.push({ kind: 'rate_limit', sessionId, data: { status: j.rate_limit_info?.status, type: j.rate_limit_info?.rateLimitType, resetsAt: j.rate_limit_info?.resetsAt } });
      break;
    case 'result': {
      const usage: Usage = { ...usageFromRaw(j.usage), costUsd: num(j.total_cost_usd) };
      const isError = !!j.is_error || (typeof j.subtype === 'string' && j.subtype !== 'success');
      out.push({
        kind: 'result', sessionId,
        data: { subtype: j.subtype, isError, text: typeof j.result === 'string' ? truncate(j.result) : '', costUsd: usage.costUsd, durationMs: j.duration_ms, numTurns: j.num_turns, stopReason: j.stop_reason },
        result: { usage, isError, subtype: String(j.subtype ?? ''), text: typeof j.result === 'string' ? j.result : '', numTurns: j.num_turns },
      });
      break;
    }
    default:
      out.push({ kind: 'system', sessionId, data: { subtype: j.type } });
  }
  return out;
}

/** Splits a byte/text stream into lines, handling chunk boundaries. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts;
  }
  flush(): string[] {
    const r = this.buf ? [this.buf] : [];
    this.buf = '';
    return r;
  }
}

/** Keep the head and tail of long command output (failures usually matter at the end). */
export function truncateOutput(s: string, max = 6000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n… [${s.length - max} characters omitted] …\n\n${s.slice(-tail)}`;
}
