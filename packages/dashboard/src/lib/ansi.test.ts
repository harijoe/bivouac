import { describe, expect, it } from 'vitest';
import { parseAnsi, spanStyle, stripAnsi } from './ansi';

const E = '\x1b[';
describe('parseAnsi', () => {
  it('returns plain text as one span and nothing for empty', () => {
    expect(parseAnsi('hello')).toEqual([{ text: 'hello' }]);
    expect(parseAnsi('')).toEqual([]);
  });
  it('handles basic colours and reset', () => {
    expect(parseAnsi(`${E}31mred${E}0m plain`)).toEqual([{ text: 'red', fg: 1 }, { text: ' plain' }]);
    expect(parseAnsi(`${E}m${E}42mx`)).toEqual([{ text: 'x', bg: 2 }]);
  });
  it('handles bright colours, attributes and their resets', () => {
    expect(parseAnsi(`${E}1;3;4;92ma${E}22;23;24;39mb`)).toEqual([{ text: 'a', bold: true, italic: true, underline: true, fg: 10 }, { text: 'b' }]);
    expect(parseAnsi(`${E}2;103ma`)).toEqual([{ text: 'a', dim: true, bg: 11 }]);
  });
  it('handles 256 and truecolor', () => {
    expect(parseAnsi(`${E}38;5;9mx`)[0].fg).toBe(9);
    expect(parseAnsi(`${E}38;5;196mx`)[0].fg).toBe('rgb(255,0,0)');
    expect(parseAnsi(`${E}38;5;244mx`)[0].fg).toBe('rgb(128,128,128)');
    expect(parseAnsi(`${E}48;2;1;2;3mx`)[0].bg).toBe('rgb(1,2,3)');
    expect(parseAnsi(`${E}38;2;300;0;0mx`)[0].fg).toBe('rgb(255,0,0)');
  });
  it('ignores malformed extended colours without throwing', () => {
    expect(parseAnsi(`${E}38mx`)).toEqual([{ text: 'x' }]);
    expect(parseAnsi(`${E}38;5;999mx`)).toEqual([{ text: 'x' }]);
  });
  it('strips other escape sequences and carriage returns', () => {
    expect(parseAnsi(`${E}2K${E}1Ghello\r`)).toEqual([{ text: 'hello' }]);
    expect(parseAnsi('\x1b]0;title\x07abc')).toEqual([{ text: 'abc' }]);
    expect(parseAnsi(`${E}?25lx${E}?25h`)).toEqual([{ text: 'x' }]);
  });
});
describe('stripAnsi', () => {
  it('removes all sequences', () => {
    expect(stripAnsi(`${E}31;1mfail${E}0m\r`)).toBe('fail');
    expect(stripAnsi('plain')).toBe('plain');
  });
});
describe('spanStyle', () => {
  it('maps palette colours to classes with a dark variant, others to inline style', () => {
    expect(spanStyle({ text: 'a', fg: 1, bold: true }).className).toMatch(/text-red-700 dark:text-red-400 font-bold/);
    expect(spanStyle({ text: 'a', fg: 'rgb(1,2,3)' }).style).toEqual({ color: 'rgb(1,2,3)' });
    expect(spanStyle({ text: 'a' })).toEqual({ className: '', style: undefined });
  });
});
