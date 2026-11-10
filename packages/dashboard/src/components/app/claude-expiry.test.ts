import { describe, expect, it } from 'vitest';
import { claudeExpiry } from './claude-expiry';

const now = Date.parse('2026-01-01T00:00:00Z');
const inDays = (n: number) => new Date(now + n * 86400_000).toISOString();
describe('claudeExpiry', () => {
  it('flags expired accounts', () => {
    expect(claudeExpiry({ kind: 'oauth', expiresAt: inDays(-1), expired: true }, now).tone).toBe('bad');
    expect(claudeExpiry({ kind: 'oauth', expiresAt: inDays(-1), expired: false }, now).tone).toBe('bad');
  });
  it('warns under 30 days', () => {
    expect(claudeExpiry({ kind: 'oauth', expiresAt: inDays(12), expired: false }, now)).toEqual({ label: 'Expires in 12 days', tone: 'warn' });
  });
  it('is fine beyond 30 days and counts months past 60', () => {
    expect(claudeExpiry({ kind: 'oauth', expiresAt: inDays(45), expired: false }, now).tone).toBe('ok');
    expect(claudeExpiry({ kind: 'oauth', expiresAt: inDays(300), expired: false }, now).label).toBe('Expires in 10 months');
  });
  it('api keys without expiry', () => {
    expect(claudeExpiry({ kind: 'apikey', expiresAt: null, expired: false }, now).label).toBe('No expiry');
  });
});
