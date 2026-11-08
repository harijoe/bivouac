import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compareSemver, parseSemver } from '@bivouac/shared';
import type { Auth } from './auth.js';
import type { DaemonConfig } from './config.js';
import type { Store } from './db.js';
import type { TaskManager } from './runner.js';

export interface ReleaseInfo { version: string; name: string; notes: string; url: string; publishedAt: string | null }
export interface UpdateProgress {
  state: 'running' | 'done' | 'failed' | 'rolled_back';
  step: string; steps: string[]; from: string; to: string; error: string | null; startedAt: string; finishedAt: string | null;
}
/** What the updater needs from the executor (the only service with Docker access). */
export interface UpdateClient { updateStart(version: string): Promise<unknown>; updateRunning(): Promise<boolean> }

const DAY = 24 * 3600_000;
const ACTIVE = ['queued', 'starting', 'running', 'checking'];
/** Automatic updates run at night, server time, when nothing is running. */
export const NIGHT_HOURS = [2, 3, 4];

/** Picks the newest published release (no drafts, no pre-releases) from a GitHub-style releases list. */
export function pickLatestRelease(list: unknown): ReleaseInfo | null {
  if (!Array.isArray(list)) return null;
  let best: ReleaseInfo | null = null;
  for (const r of list as any[]) {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string') continue;
    const v = parseSemver(r.tag_name);
    if (!v || v.pre) continue;
    const version = `${v.major}.${v.minor}.${v.patch}`;
    if (!best || compareSemver(version, best.version) > 0) {
      best = { version, name: String(r.name || r.tag_name), notes: String(r.body ?? ''), url: typeof r.html_url === 'string' ? r.html_url : '', publishedAt: r.published_at ?? null };
    }
  }
  return best;
}

/** Release detection, one-click update, scheduling and automatic updates. */
export class Updates {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private store: Store, private cfg: DaemonConfig, private mgr: TaskManager, private auth: Auth, private client: UpdateClient | null,
    private fetchImpl: typeof fetch = fetch, private now: () => Date = () => new Date()) {}

  private get statusFile() { return path.join(this.cfg.dataDir, 'update-status.json'); }

  // ---- detection
  async check(): Promise<ReleaseInfo | null> {
    try {
      const r = await this.fetchImpl(this.cfg.releasesUrl, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'bivouac' }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`the release server answered ${r.status}`);
      const latest = pickLatestRelease(await r.json());
      this.store.setSetting('update_checked_at', this.now().toISOString());
      this.store.setSetting('update_error', null);
      if (latest) this.store.setSetting('update_latest', JSON.stringify(latest));
      return latest;
    } catch (e: any) {
      this.store.setSetting('update_checked_at', this.now().toISOString());
      this.store.setSetting('update_error', `Could not check for updates: ${String(e?.message ?? e)}`);
      return null;
    }
  }
  latest(): ReleaseInfo | null {
    const raw = this.store.getSetting('update_latest');
    return raw ? JSON.parse(raw) : null;
  }
  available(): ReleaseInfo | null {
    const l = this.latest();
    return l && compareSemver(l.version, this.cfg.version) > 0 ? l : null;
  }
  autoEnabled() { return this.store.getSetting('update_auto') === '1'; }
  setAuto(on: boolean, by: string) { this.store.setSetting('update_auto', on ? '1' : null); this.auth.audit(by, 'auto_update_' + (on ? 'enabled' : 'disabled'), {}); }

  // ---- state
  scheduled(): { version: string; by: string; at: string } | null {
    const raw = this.store.getSetting('update_scheduled');
    return raw ? JSON.parse(raw) : null;
  }
  progress(): UpdateProgress | null {
    if (!existsSync(this.statusFile)) return null;
    try {
      const p: UpdateProgress = JSON.parse(readFileSync(this.statusFile, 'utf8'));
      // an update that died with the machine must not block new tasks forever
      if (p.state === 'running' && this.now().getTime() - new Date(p.startedAt).getTime() > 20 * 60_000) return { ...p, state: 'failed', error: p.error ?? 'The update stopped without reporting a result.' };
      return p;
    } catch { return null; }
  }
  /** Tasks that are queued or running. */
  busyTasks(): number {
    return this.store.db.prepare(`SELECT COUNT(*) n FROM tasks WHERE status IN (${ACTIVE.map(() => '?').join(',')})`).pluck().get(...ACTIVE) as number;
  }
  /** Why new tasks cannot start right now (shown to the assistant through MCP), or null. */
  blockReason(): string | null {
    const s = this.scheduled();
    if (s) return `bivouac is waiting for the running tasks to finish before it updates to ${s.version} (requested by ${s.by}). New tasks cannot start until the update is done: retry in a few minutes, or ask the user to cancel the scheduled update in the bivouac settings.`;
    const p = this.progress();
    if (p?.state === 'running') return `bivouac is updating to ${p.to} (step: ${p.step}). New tasks cannot start during the update: retry in about two minutes.`;
    return null;
  }
  status(isAdmin = true) {
    const p = this.progress();
    return {
      current: this.cfg.version,
      available: isAdmin ? this.available() : null,
      checkedAt: this.store.getSetting('update_checked_at'),
      error: this.store.getSetting('update_error'),
      scheduled: this.scheduled(),
      auto: this.autoEnabled(),
      runningTasks: this.busyTasks(),
      progress: p,
      canUpdate: !!this.client,
    };
  }

  // ---- actions
  /** mode "idle": update as soon as no task is running (now if none is). mode "now": stop the running tasks first. */
  async start(mode: 'idle' | 'now', by: string): Promise<{ started: boolean; scheduled: boolean }> {
    const rel = this.available();
    if (!rel) throw new Error('There is no newer version to install. Use "Check now" to look again.');
    if (!this.client) throw new Error('Updates from the dashboard are not available on this installation. Run the installer again over SSH.');
    if (this.progress()?.state === 'running' || await this.client.updateRunning()) throw new Error('An update is already running.');
    if (mode === 'idle' && this.busyTasks() > 0) {
      this.store.setSetting('update_scheduled', JSON.stringify({ version: rel.version, by, at: this.now().toISOString() }));
      this.auth.audit(by, 'update_scheduled', { from: this.cfg.version, to: rel.version });
      return { started: false, scheduled: true };
    }
    await this.launch(rel.version, by, mode);
    return { started: true, scheduled: false };
  }
  cancelSchedule(by: string) {
    if (this.scheduled()) this.auth.audit(by, 'update_schedule_cancelled', {});
    this.store.setSetting('update_scheduled', null);
  }
  private async launch(version: string, by: string, mode: string) {
    if (mode === 'now') {
      for (const id of this.store.nonTerminalTaskIds().concat(this.store.queuedTaskIds())) await this.mgr.stop(id).catch(() => {});
    }
    this.store.setSetting('update_scheduled', null);
    this.store.setSetting('update_run', JSON.stringify({ by, from: this.cfg.version, to: version, mode, at: this.now().toISOString(), audited: false }));
    this.auth.audit(by, 'update_started', { from: this.cfg.version, to: version, mode });
    try { await this.client!.updateStart(version); } catch (e) {
      this.store.setSetting('update_run', null);
      this.auth.audit(by, 'update_failed', { from: this.cfg.version, to: version, error: String((e as Error).message) });
      throw e;
    }
  }

  /** After a restart: records the result of the last update in the audit log, once. */
  recordOutcome() {
    const raw = this.store.getSetting('update_run');
    const p = this.progress();
    if (!raw || !p || p.state === 'running') return;
    const run = JSON.parse(raw);
    if (run.audited || p.to !== run.to) return;
    run.audited = true;
    this.store.setSetting('update_run', JSON.stringify(run));
    this.auth.audit(run.by, p.state === 'done' ? 'update_succeeded' : p.state === 'rolled_back' ? 'update_rolled_back' : 'update_failed', { from: run.from, to: run.to, error: p.error });
  }

  // ---- background work
  /** One pass of the scheduler: a scheduled update starts once nothing runs; the nightly automatic update too. */
  async tick(): Promise<void> {
    if (this.busy || !this.client) return;
    this.busy = true;
    try {
      this.recordOutcome();
      const checked = this.store.getSetting('update_checked_at');
      if (!checked || this.now().getTime() - new Date(checked).getTime() > DAY) await this.check();
      const sch = this.scheduled();
      if (sch && this.busyTasks() === 0 && this.progress()?.state !== 'running') {
        const rel = this.available();
        if (rel) await this.launch(rel.version, sch.by, 'scheduled').catch(() => {}); else this.store.setSetting('update_scheduled', null);
        return;
      }
      if (this.autoEnabled() && !sch && NIGHT_HOURS.includes(this.now().getHours()) && this.busyTasks() === 0 && this.progress()?.state !== 'running') {
        const rel = this.available();
        const run = this.store.getSetting('update_run');
        const failedBefore = run && JSON.parse(run).to === rel?.version; // never loop on a version that already failed
        if (rel && !failedBefore) await this.launch(rel.version, 'automatic update', 'automatic').catch(() => {});
      }
    } finally { this.busy = false; }
  }
  startBackground(intervalMs = 10_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
    this.timer.unref();
    setTimeout(() => void this.tick().catch(() => {}), 3000).unref();
  }
  stopBackground() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
