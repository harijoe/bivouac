import type { PreviewHealth, Task } from '@bivouac/shared';
import type { Store } from './db.js';
import type { Sandbox } from './sandbox.js';

/** What the supervisor writes to `.bivouac/health.json` (see packages/task-image/supervisor.mjs). */
interface HealthFile {
  state: 'starting' | 'healthy' | 'unhealthy' | 'down' | 'unknown' | 'stopped';
  since: string; lastHealthyAt: string | null; restarts: number; cause: string | null; nextRetryAt: string | null; updatedAt: string;
}

const since = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};

/**
 * Reads the health the supervisor of each task container reports and turns changes into history events and notes for the
 * agent: the preview went down (with the cause), is restarting, came back, or was given up on. Runs for the whole life of the
 * daemon, not only while an agent works: a finished task keeps its preview.
 */
export class PreviewWatch {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private store: Store, private sandboxFor: (t: Task) => Sandbox) {}

  start(everyMs = 10_000) {
    this.stop();
    this.timer = setInterval(() => { void this.tick(); }, everyMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const tasks = this.store.listTasks().filter((t) => t.ports.length > 0);
      for (let i = 0; i < tasks.length; i += 4) await Promise.all(tasks.slice(i, i + 4).map((t) => this.check(t).catch(() => {})));
    } finally { this.busy = false; }
  }

  /** One task. Exposed for tests. */
  async check(t: Task) {
    const prev = this.store.getTask(t.id)?.preview ?? null;
    if (t.status === 'queued' || t.status === 'starting') { if (prev && prev.state !== 'unknown') this.store.setPreview(t.id, null); return; }
    const now = new Date().toISOString();
    if (t.status === 'stopped') {
      if (prev?.state !== 'stopped') this.store.setPreview(t.id, { state: 'stopped', since: now, lastHealthyAt: prev?.lastHealthyAt ?? null, restarts: 0, cause: 'the task is stopped', nextRetryAt: null, updatedAt: now });
      return;
    }
    const sb = this.sandboxFor(t);
    if (!(await sb.isRunning())) {
      if (prev?.state !== 'stopped') this.store.setPreview(t.id, { state: 'stopped', since: now, lastHealthyAt: prev?.lastHealthyAt ?? null, restarts: 0, cause: 'the task container is not running', nextRetryAt: null, updatedAt: now });
      return;
    }
    const text = await sb.readFile('.bivouac/health.json').catch(() => null);
    if (!text) return;
    let h: HealthFile;
    try { h = JSON.parse(text); } catch { return; }
    const next: PreviewHealth = { state: h.state, since: h.since, lastHealthyAt: h.lastHealthyAt, restarts: h.restarts, cause: h.cause, nextRetryAt: h.nextRetryAt, updatedAt: h.updatedAt };
    // a heartbeat alone does not need a write: only changes are stored (and pushed to the dashboard)
    const same = prev && prev.state === next.state && prev.restarts === next.restarts && prev.cause === next.cause && prev.since === next.since && prev.nextRetryAt === next.nextRetryAt;
    if (!same) this.store.setPreview(t.id, next);
    this.report(t, prev, next);
  }

  private report(t: Task, prev: PreviewHealth | null, next: PreviewHealth) {
    const was = prev?.state ?? 'unknown';
    const tell = (subtype: string, message: string, extra: object = {}) => {
      this.store.addEvent(t.id, 'system', { subtype, message, state: next.state, restarts: next.restarts, cause: next.cause, ...extra });
      this.store.addNotice(t.id, message);
    };
    if (next.state === 'unhealthy' && (was !== 'unhealthy' || next.restarts !== prev?.restarts)) {
      const wait = next.nextRetryAt ? `, restarting in ${Math.max(1, Math.round((Date.parse(next.nextRetryAt) - Date.now()) / 1000))} s` : '';
      tell(was !== 'unhealthy' ? 'preview_down' : 'preview_restarting', `The preview of this task is down: ${next.cause ?? 'the dev server stopped'}. bivouac restarts it automatically (restart ${next.restarts})${wait}. Its log is /workspace/.bivouac/dev.log.`);
    } else if (next.state === 'down' && was !== 'down') {
      tell('preview_gave_up', `The preview is unavailable and bivouac gave up restarting it after ${next.restarts} attempts: ${next.cause ?? 'the dev server keeps failing'}. Fix the dev server (see /workspace/.bivouac/dev.log), then touch /workspace/.bivouac/restart.req or change the dev command in bivouac.yml to start it again.`);
    } else if (next.state === 'healthy' && (was === 'unhealthy' || was === 'down')) {
      this.store.addEvent(t.id, 'system', { subtype: 'preview_recovered', message: `The preview is back (it was unavailable for ${since(prev!.since)}).`, state: 'healthy', restarts: next.restarts, cause: next.cause });
      this.store.addNotice(t.id, `The preview is back after being down for ${since(prev!.since)}.`);
    }
  }

  /** Asks the supervisor to restart the dev server now (clears a "gave up" state too). */
  async restart(t: Task) {
    await this.sandboxFor(t).writeFile('.bivouac/restart.req', String(Date.now()));
    this.store.addEvent(t.id, 'system', { subtype: 'preview_restart_requested', message: 'A restart of the dev server was requested.' });
  }
}
