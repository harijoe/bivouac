import { describe, expect, it } from 'vitest';
import { applyHighlight, classifyLine, findMatches, fmtTs, linesToText, matchRanges, mergeLines, trimOldest, type LogLine } from './log-lines';

const L = (...ids: number[]): LogLine[] => ids.map((id) => ({ id, ts: null, text: `l${id}` }));
const ids = (l: LogLine[]) => l.map((x) => x.id);

describe('classifyLine', () => {
  it('flags errors and warnings', () => {
    for (const t of ['Error: boom', 'npm ERR! code 1', 'build failed', 'Traceback (most recent call last)', 'NullPointerException', '✗ test', 'failure']) expect(classifyLine(t), t).toBe('error');
    for (const t of ['warning: deprecated', 'WARN something']) expect(classifyLine(t), t).toBe('warn');
    for (const t of ['all good', 'terror', 'errors=0 info']) expect(classifyLine(t), t).toBeNull();
  });
  it('ignores ANSI codes and prefers errors', () => {
    expect(classifyLine('\x1b[31merror\x1b[0m')).toBe('error');
    expect(classifyLine('warning: error budget')).toBe('error');
  });
});
describe('mergeLines', () => {
  it('appends, prepends and dedupes', () => {
    expect(ids(mergeLines(L(1, 2), L(3, 4)))).toEqual([1, 2, 3, 4]);
    expect(ids(mergeLines(L(5, 6), L(3, 4)))).toEqual([3, 4, 5, 6]);
    expect(ids(mergeLines(L(1, 2, 3), L(2, 3, 4)))).toEqual([1, 2, 3, 4]);
    expect(ids(mergeLines(L(3, 4), L(1, 2, 3)))).toEqual([1, 2, 3, 4]);
    expect(ids(mergeLines(L(1, 5), L(3)))).toEqual([1, 3, 5]);
  });
  it('handles empty inputs and returns the same array when nothing is added', () => {
    const a = L(1, 2);
    expect(mergeLines(a, [])).toBe(a);
    expect(ids(mergeLines([], L(1, 2)))).toEqual([1, 2]);
    expect(ids(mergeLines([], L(2, 1, 2)))).toEqual([1, 2]);
  });
});
describe('trimOldest', () => {
  it('keeps the newest lines', () => {
    expect(ids(trimOldest(L(1, 2, 3, 4), 2))).toEqual([3, 4]);
    const a = L(1, 2);
    expect(trimOldest(a, 5)).toBe(a);
  });
});
describe('fmtTs / linesToText', () => {
  it('formats timestamps', () => {
    expect(fmtTs(null)).toBe('');
    expect(fmtTs('12:34:56.789')).toBe('12:34:56.789');
    expect(fmtTs('nonsense')).toBe('');
    expect(fmtTs('2026-01-01T10:00:00Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it('builds plain text', () => {
    const l: LogLine[] = [{ id: 1, ts: '10:00:00.000', text: '\x1b[31mhi\x1b[0m' }, { id: 2, ts: null, text: 'yo' }];
    expect(linesToText(l, true)).toBe('10:00:00.000 hi\nyo');
    expect(linesToText(l, false)).toBe('hi\nyo');
  });
});
describe('search', () => {
  it('finds ranges case-insensitively without overlap', () => {
    expect(matchRanges('Foo foo FOO', 'foo')).toEqual([[0, 3], [4, 7], [8, 11]]);
    expect(matchRanges('aaaa', 'aa')).toEqual([[0, 2], [2, 4]]);
    expect(matchRanges('abc', '')).toEqual([]);
  });
  it('finds matching lines, ignoring ANSI codes', () => {
    const l: LogLine[] = [{ id: 1, ts: null, text: 'hello' }, { id: 2, ts: null, text: '\x1b[31mHel\x1b[0mlo' }, { id: 3, ts: null, text: 'x' }];
    expect(findMatches(l, 'hello')).toEqual([0, 1]);
    expect(findMatches(l, '')).toEqual([]);
    expect(findMatches(l, '31m')).toEqual([]);
  });
  it('splits styled spans at match boundaries', () => {
    const out = applyHighlight([{ text: 'ab', fg: 1 }, { text: 'cdef' }], [[1, 3], [5, 6]]);
    expect(out.map((s) => [s.text, !!s.hl, s.fg])).toEqual([['a', false, 1], ['b', true, 1], ['c', true, undefined], ['de', false, undefined], ['f', true, undefined]]);
    expect(applyHighlight([{ text: 'x' }], [])).toEqual([{ text: 'x' }]);
  });
});
