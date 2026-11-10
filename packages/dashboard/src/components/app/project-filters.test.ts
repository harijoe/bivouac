import { describe, expect, it } from 'vitest';
import { countByFilter, matchesFilter, repoLabel, repoWebUrl } from './project-filters';

describe('task filters', () => {
  it('classifies statuses', () => {
    expect(matchesFilter('running', 'running')).toBe(true);
    expect(matchesFilter('queued', 'running')).toBe(true);
    expect(matchesFilter('succeeded', 'running')).toBe(false);
    for (const s of ['failed', 'blocked', 'stuck', 'budget_exceeded', 'max_iterations'] as const) expect(matchesFilter(s, 'attention')).toBe(true);
    expect(matchesFilter('stopped', 'attention')).toBe(false);
    expect(matchesFilter('succeeded', 'done')).toBe(true);
    expect(matchesFilter('stopped', 'all')).toBe(true);
  });
  it('counts', () => {
    expect(countByFilter([{ status: 'running' }, { status: 'failed' }, { status: 'succeeded' }, { status: 'stopped' }])).toEqual({ all: 4, running: 1, attention: 1, done: 1 });
  });
});

describe('repo urls', () => {
  it('uses the github repo', () => {
    expect(repoWebUrl({ githubRepo: 'a/b', repoUrl: 'x' })).toBe('https://github.com/a/b');
    expect(repoLabel({ githubRepo: 'a/b', repoUrl: 'x' })).toBe('a/b');
  });
  it('cleans clone urls', () => {
    expect(repoWebUrl({ githubRepo: null, repoUrl: 'https://tok@github.com/a/b.git' })).toBe('https://github.com/a/b');
    expect(repoLabel({ githubRepo: null, repoUrl: 'https://github.com/a/b.git' })).toBe('github.com/a/b');
  });
});
