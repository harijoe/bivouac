import { describe, expect, it } from 'vitest';
import { isClaudeProblem, summarize, toItems } from './task-items';

const ev = (id: number, kind: string, data: any) => ({ id, taskId: 1, kind, data, createdAt: '' }) as any;
describe('toItems', () => {
  it('groups consecutive tool calls and attaches results', () => {
    const items = toItems([
      ev(1, 'assistant_text', { text: 'hi' }), ev(2, 'tool_use', { id: 'a', name: 'Bash', input: { command: 'ls' } }), ev(3, 'tool_use', { id: 'b', name: 'Read', input: {} }),
      ev(4, 'tool_result', { toolUseId: 'a', text: 'out', isError: true }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['say', 'tools']);
    const t = items[1] as Extract<(typeof items)[number], { kind: 'tools' }>;
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]).toMatchObject({ result: 'out', bad: true });
  });
  it('maps checks, instructions, errors and system notes; skips empty text', () => {
    const items = toItems([
      ev(1, 'assistant_text', { text: '  ' }), ev(2, 'check', { exitCode: 1, command: 'npm test', output: 'x' }), ev(3, 'user_instruction', { text: 'go', queued: true }),
      ev(4, 'error', { message: 'bad' }), ev(5, 'system', { subtype: 'pr', url: 'u' }), ev(6, 'system', { subtype: 'other' }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['check', 'you', 'note', 'note']);
    expect(items[0]).toMatchObject({ ok: false, exitCode: 1 });
    expect(items[3]).toMatchObject({ href: 'u' });
  });
});
describe('helpers', () => {
  it('summarizes tool input', () => { expect(summarize({ command: 'ls -la' })).toBe('ls -la'); expect(summarize(undefined)).toBe(''); });
  it('detects Claude problems', () => {
    expect(isClaudeProblem('Claude token expired')).toBe(true);
    expect(isClaudeProblem('Usage limit reached for the account')).toBe(true);
    expect(isClaudeProblem('Tests failed')).toBe(false);
    expect(isClaudeProblem(null)).toBe(false);
  });
});
