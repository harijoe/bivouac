import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStreamLine, truncateOutput, LineSplitter, parseProjectConfig, mergeConfig, slugify, dnsPlan } from './index.js';

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

import { resolvePorts, parseServices } from './index.js';

describe('bivouac.yml: ports and services', () => {
  it('parses named ports (first is primary) and keeps the legacy dev.port', () => {
    const c = parseProjectConfig('dev:\n  command: pnpm dev\nports:\n  web: 5173\n  api: 3000\n');
    expect(resolvePorts(c)).toEqual([{ name: 'web', port: 5173, primary: true }, { name: 'api', port: 3000, primary: false }]);
    expect(resolvePorts(parseProjectConfig('dev: { command: x, port: 8080 }'))).toEqual([{ name: 'web', port: 8080, primary: true }]);
  });
  it('rejects bad ports', () => {
    expect(() => parseProjectConfig('ports: { Web: 1 }')).toThrow(/port name/);
    expect(() => parseProjectConfig('ports: { a: 0 }')).toThrow(/1 and 65535/);
    expect(() => parseProjectConfig('ports: { a: 80, b: 80 }')).toThrow(/twice/);
    expect(() => parseProjectConfig('ports: [80]')).toThrow(/mapping/);
    expect(() => parseProjectConfig('dev: { command: x }')).toThrow(/dev.port/);
  });
  it('parses services', () => {
    const c = parseProjectConfig('services:\n  postgres:\n    image: postgres:16\n    env: { POSTGRES_PASSWORD: dev, N: 5 }\n    volume: /var/lib/postgresql/data\n    memory: 1g\n    cpus: 0.5\n');
    expect(c.services!.postgres).toEqual({ image: 'postgres:16', env: { POSTGRES_PASSWORD: 'dev', N: '5' }, volume: '/var/lib/postgresql/data', memory: '1g', cpus: 0.5 });
  });
  it('rejects dangerous or malformed services', () => {
    expect(() => parseServices({ db: { image: 'postgres:16; rm -rf /' } })).toThrow(/image/);
    expect(() => parseServices({ db: { image: '-v /:/host' } })).toThrow(/image/);
    expect(() => parseServices({ db: { image: 'x', volume: '/a/../etc' } })).toThrow(/volume/);
    expect(() => parseServices({ db: { image: 'x', volume: 'rel' } })).toThrow(/volume/);
    expect(() => parseServices({ db: { image: 'x', env: { 'A B': '1' } } })).toThrow(/variable name/);
    expect(() => parseServices({ web: { image: 'x' } })).toThrow(/reserved/);
    expect(() => parseServices({ 'Bad_Name': { image: 'x' } })).toThrow(/service name/);
    expect(() => parseServices({ db: { image: 'x', memory: '1 gig' } })).toThrow(/memory/);
    expect(() => parseServices(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}`, { image: 'x' }])))).toThrow(/at most/);
  });
});

describe('dnsPlan', () => {
  const names = (d: string) => dnsPlan(d, '1.2.3.4').records.map((r) => r.name);
  it('uses @ and * for a root domain', () => { expect(names('bivouac.cloud')).toEqual(['@', '*']); expect(dnsPlan('bivouac.cloud', '1.2.3.4').zone).toBe('bivouac.cloud'); });
  it('uses names relative to the zone for a subdomain', () => { expect(names('dev.deslope.com')).toEqual(['dev', '*.dev']); expect(names('a.b.deslope.com')).toEqual(['a.b', '*.a.b']); });
  it('handles multi-level public suffixes', () => {
    expect(names('mysite.co.uk')).toEqual(['@', '*']);
    expect(names('bv.mysite.co.uk')).toEqual(['bv', '*.bv']);
    expect(dnsPlan('bv.mysite.co.uk', '1.2.3.4').zone).toBe('mysite.co.uk');
    expect(names('app.example.com.au')).toEqual(['app', '*.app']);
  });
});
