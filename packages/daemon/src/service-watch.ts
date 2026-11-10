import type { Store } from './db.js';
import type { Sandbox, ServiceState } from './sandbox.js';

export const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${+(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** The sentence shown to the owner (and to the agent) about one incident. */
export function describeIncident(s: ServiceState, how: 'restarted' | 'stayed_down'): { cause: 'oom' | 'exit' | 'restart'; message: string } {
  const limit = s.memoryLimit ? fmtBytes(s.memoryLimit) : null;
  // Docker's OOMKilled flag is sometimes missed when the process dies at once: a SIGKILL (137) of a service nobody stopped is
  // treated as a memory kill too, with a more careful sentence.
  if (s.oomKilled || (!s.running && s.exitCode === 137)) {
    const what = s.oomKilled ? 'was killed because it ran out of memory' : 'was killed (exit code 137, which almost always means it ran out of memory)';
    return {
      cause: 'oom',
      message: `The service “${s.name}” ${what} (limit ${limit ?? 'unknown'}). ${how === 'restarted' ? 'bivouac started it again; its data volume is intact. ' : ''}Raise the limit with \`services.${s.name}.memory\` in bivouac.yml (for example \`memory: 2g\`) if it keeps happening.`,
    };
  }
  if (s.running) return { cause: 'restart', message: `The service “${s.name}” restarted (${s.restartCount} time${s.restartCount === 1 ? '' : 's'}). Its memory limit is ${limit ?? 'unknown'}.` };
  return { cause: 'exit', message: `The service “${s.name}” stopped unexpectedly (exit code ${s.exitCode ?? '?'}; memory limit ${limit ?? 'unknown'}). ${how === 'restarted' ? 'bivouac started it again.' : 'bivouac gave up restarting it.'}` };
}

const MAX_RESTARTS = 5;

/**
 * Watches the sidecars of one running task. A service killed by the kernel for exceeding its memory (or stopped for any
 * other reason) is reported in the task history and restarted, a few times at most. Created at the start of a task run.
 */
export class ServiceWatch {
  private seen = new Map<string, string>();
  private restarts = new Map<string, number>();
  private notices: string[] = [];
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private store: Store, private taskId: number, private sb: Sandbox) {}

  private sig = (s: ServiceState) => `${s.startedAt}|${s.finishedAt}|${s.restartCount}`;

  /** Takes the current state as the starting point: only what happens afterwards is reported. */
  async baseline() {
    for (const s of await this.sb.serviceStates().catch(() => [])) this.seen.set(s.name, this.sig(s));
  }
  start(everyMs = 10_000) {
    this.stop();
    this.timer = setInterval(() => { void this.check(); }, everyMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** What happened since the last call, written for the agent's next prompt. */
  takeNotices(): string[] { const n = this.notices; this.notices = []; return n; }

  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const s of await this.sb.serviceStates().catch(() => [] as ServiceState[])) {
        const sig = this.sig(s);
        if (this.seen.get(s.name) === sig) continue; // nothing new (or already reported and not restartable)
        this.seen.set(s.name, sig);
        const n = this.restarts.get(s.name) ?? 0;
        const restart = !s.running && n < MAX_RESTARTS;
        const { cause, message } = describeIncident(s, restart ? 'restarted' : s.running ? 'restarted' : 'stayed_down');
        this.store.addEvent(this.taskId, 'system', { subtype: 'service_incident', service: s.name, cause, exitCode: s.exitCode, memoryLimit: s.memoryLimit, message });
        this.notices.push(message);
        if (restart) {
          this.restarts.set(s.name, n + 1);
          await this.sb.restartService(s.name).catch((e) => this.store.addEvent(this.taskId, 'system', { subtype: 'service_incident', service: s.name, cause: 'exit', message: `The service “${s.name}” could not be started again: ${String(e?.message ?? e)}` }));
          const after = (await this.sb.serviceStates().catch(() => [] as ServiceState[])).find((x) => x.name === s.name);
          if (after) this.seen.set(s.name, this.sig(after));
        }
      }
    } finally { this.busy = false; }
  }
}
