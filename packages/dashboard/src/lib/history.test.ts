import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@bivouac/shared';
import { applyEvent, attemptFromHash, emptyHistory, mergeAttempts, mergeEvents, splitMatches, type HistoryState } from './history';

let id = 100;
const ev = (kind: string, data: any, iteration: number, at = '2026-11-10T10:00:00.000Z'): TaskEvent => ({ id: ++id, taskId: 1, iteration, kind: kind as never, data, createdAt: at });
const fold = (events: TaskEvent[], from: HistoryState = emptyHistory) => events.reduce(applyEvent, from);

describe('live events in the history', () => {
  it('opens a new attempt on top and gives it what happened since the previous one as its markers', () => {
    let h = fold([ev('status', { status: 'running' }, 1), ev('assistant_text', { text: 'working' }, 1), ev('check', { exitCode: 1, command: 'c' }, 1)]);
    expect(h.attempts.map((a) => a.attempt)).toEqual([1]);
    h = fold([ev('status', { status: 'stopped' }, 1), ev('user_instruction', { text: 'go on', queued: true }, 1), ev('status', { status: 'queued' }, 1)], h);
    expect(h.attempts).toHaveLength(1);
    expect(h.trailing.map((m) => m.kind === 'state' ? m.status : m.kind)).toEqual(['stopped', 'instruction', 'resumed']);
    h = fold([ev('status', { status: 'running' }, 2)], h);
    expect(h.attempts.map((a) => a.attempt)).toEqual([2, 1]);
    expect(h.attempts[0].markers.map((m) => m.kind)).toEqual(['state', 'instruction', 'state']);
    expect(h.trailing).toEqual([]);
    expect(h.attempts[1].markers).toEqual([]);
  });

  it('keeps the header of the running attempt up to date: last message, check, cost; ignores thinking and duplicates', () => {
    const events = [ev('status', { status: 'running' }, 3, '2026-11-10T10:00:00.000Z'), ev('assistant_text', { text: 'reading' }, 3, '2026-11-10T10:00:05.000Z'), ev('assistant_text', { text: 'hmm', thinking: true }, 3, '2026-11-10T10:00:06.000Z'),
      ev('result', { costUsd: 0.25 }, 3, '2026-11-10T10:01:00.000Z'), ev('check', { exitCode: 0, command: 'pnpm test' }, 3, '2026-11-10T10:01:30.000Z')];
    const h = fold(events);
    const again = fold(events, h);
    const a = again.attempts[0];
    expect(a).toMatchObject({ attempt: 3, lastMessage: 'reading', costUsd: 0.25, check: { passed: true, command: 'pnpm test' }, durationMs: 90_000 });
    expect(again.live[3].map((e) => e.kind)).toEqual(['assistant_text', 'assistant_text', 'result', 'check']);
  });

  it('does not invent an attempt for an older event, and ignores attempt 0', () => {
    const h = fold([ev('status', { status: 'queued' }, 0), ev('system', { subtype: 'clone' }, 0), ev('status', { status: 'running' }, 5)]);
    expect(h.attempts.map((a) => a.attempt)).toEqual([5]);
    expect(fold([ev('assistant_text', { text: 'old' }, 2)], h).attempts.map((a) => a.attempt)).toEqual([5]);
  });

  it('merges pages and loaded events without duplicates', () => {
    const a = (n: number) => ({ attempt: n, startedAt: '', endedAt: '', durationMs: 0, running: false, costUsd: 0, check: null, lastMessage: null, firstEventId: n, lastEventId: n, markers: [] });
    const h = mergeAttempts({ ...emptyHistory, attempts: [a(5), a(4)] }, { attempts: [a(4), a(3)], hasMore: true }, 'append');
    expect(h.attempts.map((x) => x.attempt)).toEqual([5, 4, 3]);
    expect(h.hasMore).toBe(true);
    const e1 = ev('assistant_text', { text: 'a' }, 1), e2 = ev('assistant_text', { text: 'b' }, 1);
    expect(mergeEvents([e1], [e2, e1]).map((e) => e.id)).toEqual([e1.id, e2.id]);
  });
});

describe('helpers', () => {
  it('highlights case-insensitively and leaves short queries alone', () => {
    expect(splitMatches('Fix the Login page, login again', 'login')).toEqual([
      { text: 'Fix the ', match: false }, { text: 'Login', match: true }, { text: ' page, ', match: false }, { text: 'login', match: true }, { text: ' again', match: false },
    ]);
    expect(splitMatches('abc', 'a')).toEqual([{ text: 'abc', match: false }]);
    expect(splitMatches('abc', 'zz')).toEqual([{ text: 'abc', match: false }]);
  });
  it('reads the attempt from the URL hash', () => {
    expect(attemptFromHash('#attempt-12')).toBe(12);
    expect(attemptFromHash('#logs')).toBeNull();
    expect(attemptFromHash('#attempt-x')).toBeNull();
  });
});
