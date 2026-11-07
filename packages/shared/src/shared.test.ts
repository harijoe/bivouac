import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStreamLine, truncateOutput, LineSplitter, parseProjectConfig, mergeConfig, slugify } from './index.js';

describe('stream-json parser (real fixture)', () => {
  const lines = readFileSync(new URL('../fixtures/real-run.jsonl', import.meta.url), 'utf8').trim().split('\n');
  const events = lines.flatMap(parseStreamLine);
  it('extracts session id, tool calls, text and result', () => {
    expect(events[0].kind).toBe('system');
    expect(events[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.filter((e) => e.kind === 'tool_use').map((e) => e.data.name)).toEqual(['Read', 'Edit']);
    expect(events.some((e) => e.kind === 'assistant_text' && e.data.text === 'Done.')).toBe(true);
    expect(events.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
    const r = events.find((e) => e.kind === 'result')!;
    expect(r.result!.usage.costUsd).toBeGreaterThan(0);
    expect(r.result!.usage.outputTokens).toBeGreaterThan(0);
    expect(r.result!.isError).toBe(false);
  });
  it('tolerates garbage', () => {
    expect(parseStreamLine('not json')[0].data.unparsed).toBe(true);
    expect(parseStreamLine('')).toEqual([]);
  });
});
describe('helpers', () => {
  it('splits lines across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb')).toEqual(['a']);
    expect(s.push('c\nd\n')).toEqual(['bc', 'd']);
    expect(s.flush()).toEqual([]);
  });
  it('truncates keeping tail', () => {
    const t = truncateOutput('a'.repeat(5000) + 'END', 1000);
    expect(t.length).toBeLessThan(1200);
    expect(t.endsWith('END')).toBe(true);
  });
  it('parses config', () => {
    const c = parseProjectConfig('setup: pnpm i\ndev:\n  command: pnpm dev\n  port: 5173\nbudget:\n  max_cost_usd: 3\n');
    expect(c.dev?.port).toBe(5173);
    expect(mergeConfig(c, { budget: { max_iterations: 2 } }).budget).toEqual({ max_iterations: 2, max_cost_usd: 3 });
    expect(() => parseProjectConfig('dev: {command: x}')).toThrow();
    expect(() => parseProjectConfig('limits: {memory: lots}')).toThrow();
  });
  it('slugifies', () => expect(slugify('Fix the Bug!! in /api')).toBe('fix-the-bug-in-api'));
});
