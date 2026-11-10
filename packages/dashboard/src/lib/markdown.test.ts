import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('parses bold, code and links', () => {
    expect(parseInline('a **b** `c` [d](https://x.io/y)')).toEqual([
      { t: 'text', v: 'a ' }, { t: 'bold', v: 'b' }, { t: 'text', v: ' ' }, { t: 'code', v: 'c' }, { t: 'text', v: ' ' }, { t: 'link', v: 'd', href: 'https://x.io/y' },
    ]);
  });
  it('keeps unsafe links and html as plain text', () => {
    expect(parseInline('[x](javascript:alert(1)) <b>hi</b>')).toEqual([{ t: 'text', v: '[x](javascript:alert(1)) <b>hi</b>' }]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings, lists, paragraphs and code fences', () => {
    const b = parseMarkdown('## New\n- one\n* two\n\ntext\n```\ncode **x**\n```\n');
    expect(b.map((x) => x.t)).toEqual(['heading', 'list', 'p', 'code']);
    expect(b[1]).toMatchObject({ items: [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two' }]] });
    expect(b[3]).toEqual({ t: 'code', v: 'code **x**' });
  });
  it('closes an unterminated code fence', () => {
    expect(parseMarkdown('```\na')).toEqual([{ t: 'code', v: 'a' }]);
  });
  it('handles CRLF and empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('a\r\nb')).toHaveLength(2);
  });
});
