import { describe, expect, it } from 'vitest';
import { aliasError, aliasUrl, fmtBytes, parsePaths, pathsError, secretNameError, shortFingerprint } from './project-env';

describe('fmtBytes', () => {
  it('formats', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(412_000_000)).toBe('412 MB');
    expect(fmtBytes(1_300_000_000)).toBe('1.3 GB');
    expect(fmtBytes(2_000)).toBe('2 kB');
    expect(fmtBytes(999)).toBe('999 B');
  });
});
describe('alias', () => {
  it('validates', () => {
    expect(aliasError('')).toBe('');
    expect(aliasError('app-1')).toBe('');
    expect(aliasError('App')).not.toBe('');
    expect(aliasError('a'.repeat(31))).not.toBe('');
    expect(aliasError('-a')).not.toBe('');
  });
  it('builds the url', () => {
    expect(aliasUrl('app', 'dev.example.com', 'https://dev.example.com')).toBe('https://app.dev.example.com');
  });
});
describe('paths', () => {
  it('parses', () => expect(parsePaths(' /a/ \n\n/a/\n/b')).toEqual(['/a/', '/b']));
  it('validates', () => {
    expect(pathsError(['/api/webhooks/'])).toBe('');
    expect(pathsError(['api'])).toContain('start with /');
    expect(pathsError(['/a b'])).not.toBe('');
    expect(pathsError(Array.from({ length: 11 }, (_, i) => `/p${i}`))).toContain('At most 10');
  });
  it('shortens', () => expect(shortFingerprint('abcdef0123456789')).toBe('abcdef012345'));
});

describe('secretNameError', () => {
  it('validates', () => {
    expect(secretNameError('')).toBe('');
    expect(secretNameError('LINEAR_API_KEY')).toBe('');
    expect(secretNameError('linear')).not.toBe('');
    expect(secretNameError('1KEY')).not.toBe('');
    expect(secretNameError('A'.repeat(64))).not.toBe('');
  });
});
