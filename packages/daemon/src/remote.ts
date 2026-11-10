import type { ExecOpts, PrepareOpts, Sandbox, SandboxSpec, ServiceState } from './sandbox.js';
import type { LoginSession } from './executor.js';

/** Client for the executor API. Implements Sandbox so the task runner does not care where Docker lives. */
export class ExecutorClient {
  constructor(private baseUrl: string, private token: string) {}
  async call<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const r = await this.raw(method, path, body, signal);
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`executor: ${j.error ?? r.status}`);
    return j as T;
  }
  raw(method: string, path: string, body?: unknown, signal?: AbortSignal) {
    return fetch(this.baseUrl + path, { method, headers: { 'x-executor-token': this.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  }
  sandbox(taskId: number, project: string): Sandbox { return new RemoteSandbox(this, taskId, project); }
  // Claude login (setup-token) sessions
  loginStart() { return this.call<LoginSession>('POST', '/claude-login'); }
  loginGet(id: string) { return this.call<LoginSession>('GET', `/claude-login/${id}`); }
  loginInput(id: string, text: string) { return this.call('POST', `/claude-login/${id}/input`, { text }); }
  loginCancel(id: string) { return this.call('DELETE', `/claude-login/${id}`); }
  updateStart(version: string) { return this.call('POST', '/update/start', { version }); }
  async updateRunning() { return (await this.call<{ running: boolean }>('GET', '/update/running')).running; }
  async healthy() { try { return (await fetch(this.baseUrl + '/health')).ok; } catch { return false; } }
}

export class RemoteSandbox implements Sandbox {
  readonly ws = '/workspace';
  private q: string;
  constructor(private c: ExecutorClient, private id: number, project: string) { this.q = `project=${encodeURIComponent(project)}`; }
  private p(path: string, extra = '') { return `/sandboxes/${this.id}/${path}?${this.q}${extra}`; }
  async prepareRepo(o: PrepareOpts) { return (await this.c.call('POST', this.p('prepare'), o)).cloned as boolean; }
  async start(spec: SandboxSpec) { await this.c.call('POST', this.p('start'), { env: spec.env, cpus: spec.cpus, memory: spec.memory, services: spec.services }); }
  async push(o: { branch: string; token: string | null }) { await this.c.call('POST', this.p('push'), o); }
  async unpushed() { return (await this.c.call('GET', this.p('unpushed'))).count as number; }
  async tail(rel: string, o: { before?: number; after?: number; bytes?: number } = {}) {
    const q = `&path=${encodeURIComponent(rel)}${o.before !== undefined ? `&before=${o.before}` : ''}${o.after !== undefined ? `&after=${o.after}` : ''}${o.bytes ? `&bytes=${o.bytes}` : ''}`;
    return (await this.c.call('GET', this.p('tail', q))) as { text: string; start: number; end: number; size: number };
  }
  async serviceLogs(name: string, tail: number) { return (await this.c.call('GET', this.p('service-logs', `&name=${encodeURIComponent(name)}&tail=${tail}`))).text as string; }
  async serviceStates() { return (await this.c.call('GET', this.p('service-states'))).states as ServiceState[]; }
  async restartService(name: string) { await this.c.call('POST', this.p('service-restart', `&name=${encodeURIComponent(name)}`)); }
  async fingerprint() { return (await this.c.call('GET', this.p('fingerprint'))).hash as string; }
  async readFile(rel: string) { return (await this.c.call('GET', this.p('file', `&path=${encodeURIComponent(rel)}`))).content as string | null; }
  async writeFile(rel: string, content: string) { await this.c.call('PUT', this.p('file'), { path: rel, content }); }
  async isRunning() { return (await this.c.call('GET', this.p('running'))).running as boolean; }
  async stop() { await this.c.call('POST', this.p('stop')); }
  async destroy() { await this.c.call('POST', this.p('destroy')); }

  async exec(cmd: string[], o: ExecOpts = {}): Promise<number> {
    const ac = new AbortController();
    if (o.signal?.aborted) ac.abort(); else o.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    // Aborting the HTTP request makes the executor kill the process inside the container.
    let res: Response;
    try { res = await this.c.raw('POST', this.p('exec'), { cmd, cwd: o.cwd, env: o.env }, ac.signal); } catch { return ac.signal.aborted ? 143 : 1; }
    if (!res.ok || !res.body) return 1;
    const dec = new TextDecoder();
    let buf = '', code: number | null = null;
    const line = (l: string) => {
      if (!l) return;
      const m = JSON.parse(l);
      if (m.t) o.onData?.(m.d, m.t === 'o' ? 'stdout' : 'stderr');
      else if (m.x !== undefined) code = m.x;
    };
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
    } catch { /* connection dropped or aborted */ }
    if (buf) line(buf);
    return code ?? (ac.signal.aborted ? 143 : 1);
  }
}
