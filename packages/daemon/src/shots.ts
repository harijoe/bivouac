import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AttemptShots, ProjectConfig, Shot, ShotProblem, Task } from '@bivouac/shared';
import { DEFAULT_SCREENSHOT_PAGES, resolvePorts } from '@bivouac/shared';
import type { Store } from './db.js';
import type { Sandbox } from './sandbox.js';

/** Widths of the photographs: a phone and a laptop. */
export const SHOT_WIDTHS = [375, 1280] as const;
/** Storage bounds per task: the newest attempts are kept up to this many, and up to this many bytes in total. */
export const SHOT_KEEP_ATTEMPTS = 12;
export const SHOT_MAX_BYTES = 60 * 1024 * 1024;
/** A capture that takes longer than this is abandoned (and reported): it never holds an attempt up. */
export const SHOT_TIMEOUT_MS = 150_000;
const script = () => process.env.BIVOUAC_SHOT_SCRIPT || '/opt/bivouac/shot.mjs';

/** What `shot.mjs` writes to result.json. */
interface ScriptResult {
  reachable: boolean; error: string | null;
  pages: { page: string; width: number; file: string | null; small: string | null; httpStatus: number | null; title: string | null; blank: boolean; consoleErrors: string[]; failedRequests: Shot['failedRequests']; problems: ShotProblem[] }[];
}

/**
 * Photographs the preview after an attempt (see packages/task-image/shot.mjs: headless Chromium inside the task container, on
 * the loopback, so the preview's access check is not involved), copies the images into the web data directory and keeps them
 * within a bounded size. A failure here is recorded and shown, never raised: a capture must not fail an attempt.
 */
export class Shots {
  constructor(private store: Store, private dataDir: string) {}
  dirOf(taskId: number) { return path.join(this.dataDir, 'shots', `t${taskId}`); }
  private file(taskId: number, attempt: number, id: number, small: boolean) { return path.join(this.dirOf(taskId), `a${attempt}`, `${id}${small ? '-s' : ''}.jpg`); }

  /** Runs the capture for one attempt. Resolves with a one-line summary for the history; never throws. */
  async capture(t: Task, sb: Sandbox, eff: ProjectConfig, attempt: number, checkPassed: boolean | null, signal?: AbortSignal): Promise<{ ok: boolean; count: number; problems: number; message: string }> {
    const fail = (error: string) => {
      this.store.db.prepare('INSERT OR REPLACE INTO shot_runs(task_id,attempt,check_passed,error) VALUES(?,?,?,?)').run(t.id, attempt, checkPassed === null ? null : checkPassed ? 1 : 0, error);
      return { ok: false, count: 0, problems: 0, message: error };
    };
    try {
      const port = resolvePorts(eff)[0]?.port;
      if (!port) return fail('No port is configured for the preview, so nothing was photographed.');
      const rel = `.bivouac/shots/a${attempt}`;
      const pages = eff.preview?.screenshots?.length ? eff.preview.screenshots : DEFAULT_SCREENSHOT_PAGES;
      await sb.writeFile('.bivouac/shots-spec.json', JSON.stringify({ base: `http://127.0.0.1:${port}`, pages, widths: SHOT_WIDTHS, out: `${sb.ws}/${rel}` }));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SHOT_TIMEOUT_MS);
      const onAbort = () => ac.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let code: number, log = '';
      try { code = await sb.exec(['node', script(), `${sb.ws}/.bivouac/shots-spec.json`], { cwd: sb.ws, signal: ac.signal, onData: (c) => { log += c; } }); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
      if (signal?.aborted) return { ok: true, count: 0, problems: 0, message: 'Capture cancelled (the task was stopped).' };
      if (ac.signal.aborted) return fail(`The capture took more than ${SHOT_TIMEOUT_MS / 1000} s and was abandoned.`);
      const text = await sb.readFile(`${rel}/result.json`);
      if (!text) return fail(`The capture tool produced no result (exit code ${code}). ${log.trim().slice(-400)}`);
      const res = JSON.parse(text) as ScriptResult;
      if (!res.reachable) return fail(res.error ?? 'The dev server did not answer.');
      let count = 0, problems = 0;
      const ins = this.store.db.prepare('INSERT INTO shots(task_id,attempt,page,width,http_status,title,ok,blank,problems_json,console_json,failed_json,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      this.store.db.prepare('DELETE FROM shots WHERE task_id=? AND attempt=?').run(t.id, attempt);
      rmSync(path.join(this.dirOf(t.id), `a${attempt}`), { recursive: true, force: true });
      for (const p of res.pages) {
        const full = p.file ? await sb.readBinary(`${rel}/${p.file}`) : null;
        const small = p.small ? await sb.readBinary(`${rel}/${p.small}`) : null;
        const ok = p.problems.length === 0;
        const info = ins.run(t.id, attempt, p.page, p.width, p.httpStatus, p.title, ok ? 1 : 0, p.blank ? 1 : 0, JSON.stringify(p.problems), JSON.stringify(p.consoleErrors), JSON.stringify(p.failedRequests), (full?.length ?? 0) + (small?.length ?? 0));
        const id = Number(info.lastInsertRowid);
        if (full || small) mkdirSync(path.join(this.dirOf(t.id), `a${attempt}`), { recursive: true });
        if (full) writeFileSync(this.file(t.id, attempt, id, false), full);
        if (small) writeFileSync(this.file(t.id, attempt, id, true), small);
        count++; if (!ok) problems++;
      }
      this.store.db.prepare('INSERT OR REPLACE INTO shot_runs(task_id,attempt,check_passed,error) VALUES(?,?,?,NULL)').run(t.id, attempt, checkPassed === null ? null : checkPassed ? 1 : 0);
      await sb.exec(['rm', '-rf', `${sb.ws}/.bivouac/shots`, `${sb.ws}/.bivouac/shots-spec.json`]).catch(() => 0);
      this.prune(t.id);
      return { ok: true, count, problems, message: problems ? `${count} screenshot(s) taken, ${problems} with a problem.` : `${count} screenshot(s) taken.` };
    } catch (e: any) {
      return fail(`The screenshots could not be taken: ${String(e?.message ?? e).slice(0, 400)}`);
    }
  }

  /** Oldest attempts go first when there are too many, or too many bytes; the newest attempt always stays. */
  prune(taskId: number) {
    const attempts = (this.store.db.prepare('SELECT attempt, SUM(bytes) AS bytes FROM shots WHERE task_id=? GROUP BY attempt ORDER BY attempt DESC').all(taskId) as { attempt: number; bytes: number }[]);
    let total = 0;
    attempts.forEach((a, i) => {
      total += a.bytes;
      if (i === 0) return;
      if (i >= SHOT_KEEP_ATTEMPTS || total > SHOT_MAX_BYTES) this.dropAttempt(taskId, a.attempt);
    });
  }
  private dropAttempt(taskId: number, attempt: number) {
    this.store.db.prepare('DELETE FROM shots WHERE task_id=? AND attempt=?').run(taskId, attempt);
    this.store.db.prepare('DELETE FROM shot_runs WHERE task_id=? AND attempt=?').run(taskId, attempt);
    rmSync(path.join(this.dirOf(taskId), `a${attempt}`), { recursive: true, force: true });
  }
  /** With the task: images and rows (rows also go with the task by cascade). */
  purge(taskId: number) { rmSync(this.dirOf(taskId), { recursive: true, force: true }); }

  private shotFromRow(r: any): Shot {
    const problems: ShotProblem[] = JSON.parse(r.problems_json);
    return { id: r.id, taskId: r.task_id, attempt: r.attempt, page: r.page, width: r.width, httpStatus: r.http_status, title: r.title, ok: !!r.ok, blank: !!r.blank, problems, consoleErrors: JSON.parse(r.console_json), failedRequests: JSON.parse(r.failed_json), bytes: r.bytes, createdAt: r.created_at };
  }
  /** Captures of one attempt, or of the newest attempts (newest first) with the outcome of each capture run. */
  list(taskId: number, o: { attempt?: number; limit?: number } = {}): AttemptShots[] {
    const runs = (o.attempt !== undefined
      ? this.store.db.prepare('SELECT * FROM shot_runs WHERE task_id=? AND attempt=?').all(taskId, o.attempt)
      : this.store.db.prepare('SELECT * FROM shot_runs WHERE task_id=? ORDER BY attempt DESC LIMIT ?').all(taskId, Math.min(Math.max(o.limit ?? SHOT_KEEP_ATTEMPTS, 1), 50))) as any[];
    return runs.map((r) => ({
      attempt: r.attempt, checkPassed: r.check_passed === null ? null : !!r.check_passed, error: r.error,
      shots: (this.store.db.prepare('SELECT * FROM shots WHERE task_id=? AND attempt=? ORDER BY page, width').all(taskId, r.attempt) as any[]).map((x) => this.shotFromRow(x)),
    }));
  }
  getShot(taskId: number, id: number): Shot | null {
    const r = this.store.db.prepare('SELECT * FROM shots WHERE task_id=? AND id=?').get(taskId, id);
    return r ? this.shotFromRow(r) : null;
  }
  image(taskId: number, id: number, variant: 'small' | 'full'): Buffer | null {
    const s = this.getShot(taskId, id);
    if (!s) return null;
    const p = this.file(taskId, s.attempt, id, variant === 'small');
    return existsSync(p) ? readFileSync(p) : null;
  }
}
