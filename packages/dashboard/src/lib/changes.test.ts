import { describe, expect, it } from 'vitest';
import type { Shot } from '@bivouac/shared';
import { browseOrder, classifyPatch, diffHeadline, diffOrigin, fileLabel, groupByPage, nextWindow, previousShot, shotBadges } from './changes';
import { restartNote, retryInSeconds, shareEnd } from './preview';

const shot = (o: Partial<Shot>): Shot => ({ id: 1, taskId: 1, attempt: 2, page: '/', width: 375, httpStatus: 200, title: null, ok: true, blank: false, problems: [], consoleErrors: [], failedRequests: [], bytes: 1, createdAt: '', ...o });

describe('classifyPatch', () => {
  it('treats lines before the first hunk as headers and keeps "--" deletions as deletions', () => {
    const r = classifyPatch(['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '--old', '+new', ' same', '\\ No newline at end of file']);
    expect(r.kinds).toEqual(['meta', 'meta', 'hunk', 'del', 'add', 'ctx', 'meta']);
    expect(r.inHunk).toBe(true);
  });
  it('carries the hunk state into the next window', () => {
    expect(classifyPatch(['+++x'], true).kinds).toEqual(['add']);
  });
});
describe('diff text', () => {
  it('headline and origin', () => {
    expect(diffHeadline({ files: 1, added: 3, deleted: 0 })).toBe('1 file, +3 −0');
    expect(diffOrigin({ committed: false, uncommitted: true, commits: [] })).toBe('Uncommitted changes only');
    expect(diffOrigin({ committed: true, uncommitted: false, commits: [1, 2] })).toBe('2 commits');
  });
  it('renames show both paths', () => {
    expect(fileLabel({ path: 'b', oldPath: 'a', status: 'renamed', added: 0, deleted: 0, binary: false })).toBe('a → b');
  });
  it('next window', () => {
    expect(nextWindow(1000, 400)).toEqual({ next: 400, hidden: 600 });
    expect(nextWindow(450, 400)).toEqual({ next: 50, hidden: 50 });
    expect(nextWindow(450, null)).toEqual({ next: 0, hidden: 0 });
  });
});
describe('shots', () => {
  it('badges', () => {
    expect(shotBadges(shot({}))).toEqual([{ label: 'OK', bad: false }]);
    const b = shotBadges(shot({ ok: false, httpStatus: 404, blank: true, consoleErrors: ['a', 'b'], failedRequests: [{ url: 'u' }] })).map((x) => x.label);
    expect(b).toEqual(['HTTP 404', 'Blank page', 'Console errors 2', 'Failed requests 1']);
    expect(shotBadges(shot({ ok: false, problems: [{ kind: 'timeout', message: 'slow' }] }))[0].label).toBe('Timed out');
  });
  it('groups by page and orders phone first', () => {
    const list = [shot({ id: 1, page: '/a', width: 1280 }), shot({ id: 2, page: '/b' }), shot({ id: 3, page: '/a' })];
    expect(groupByPage(list).map((g) => [g.page, g.shots.map((s) => s.id)])).toEqual([['/a', [3, 1]], ['/b', [2]]]);
    expect(browseOrder(list).map((s) => s.id)).toEqual([3, 1, 2]);
  });
  it('finds the previous attempt shot', () => {
    const all = [{ attempt: 1, checkPassed: null, error: null, shots: [shot({ id: 9, attempt: 1 })] }];
    expect(previousShot(all, shot({}))?.id).toBe(9);
    expect(previousShot(all, shot({ page: '/z' }))).toBeNull();
  });
});
describe('preview', () => {
  const p = { state: 'unhealthy', since: '', lastHealthyAt: null, restarts: 2, cause: 'exit 1', nextRetryAt: new Date(10_000).toISOString(), updatedAt: '' } as const;
  it('retry countdown never goes negative', () => {
    expect(retryInSeconds(p, 4_000)).toBe(6);
    expect(retryInSeconds(p, 20_000)).toBe(0);
    expect(retryInSeconds({ ...p, nextRetryAt: null })).toBeNull();
  });
  it('restart note only when healthy', () => {
    expect(restartNote(p)).toBeNull();
    expect(restartNote({ ...p, state: 'healthy' })).toBe('restarted 2 times, last cause: exit 1');
  });
  it('share end', () => {
    expect(shareEnd({ createdAt: 0, expiresAt: 5, revoked: true, active: false })).toBe('Revoked');
    expect(shareEnd({ createdAt: 0, expiresAt: 5, revoked: false, active: false })).toMatch(/^Expired/);
  });
});
