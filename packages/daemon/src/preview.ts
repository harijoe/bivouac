import { createHmac } from 'node:crypto';
import type { DaemonConfig } from './config.js';
import type { Store } from './db.js';
import { randomToken, sha256 } from './auth.js';
import { decrypt, encrypt, safeEqual } from './crypto.js';

export const PREVIEW_COOKIE = 'bv_preview';
export const SHARE_DURATIONS = { '1h': 3600, '24h': 86400, '7d': 7 * 86400, never: null } as const;
export type ShareDuration = keyof typeof SHARE_DURATIONS;
const TICKET_TTL = 60;
const OWNER_COOKIE_TTL = 12 * 3600;

export interface ShareLink { id: number; taskId: number; createdAt: number; expiresAt: number | null; revoked: boolean; active: boolean }

export type PreviewDecision =
  | { kind: 'allow'; cookieHeader: string }
  | { kind: 'redirect'; location: string; setCookie: string }
  | { kind: 'deny'; reason: 'no_task' | 'no_access' | 'expired' | 'revoked' };

interface CookiePayload { h: string; k: 'owner' | 'share'; s?: number; e: number }

/** Owner tickets, share links and preview cookies: everything that decides who may see an agent's running app. */
export class Previews {
  constructor(private store: Store, private cfg: DaemonConfig, private secret: Buffer) {}
  private get db() { return this.store.db; }
  private now() { return Math.floor(Date.now() / 1000); }

  // ---- owner tickets
  createTicket(taskId: number): string {
    const t = randomToken(32);
    this.db.prepare('INSERT INTO preview_tickets(hash, task_id, expires_at) VALUES (?,?,?)').run(sha256(t), taskId, this.now() + TICKET_TTL);
    this.db.prepare('DELETE FROM preview_tickets WHERE expires_at < ?').run(this.now());
    return t;
  }
  /** Single use: the ticket is deleted on the first read. */
  consumeTicket(ticket: string, taskId: number): boolean {
    const row = this.db.prepare('SELECT * FROM preview_tickets WHERE hash=?').get(sha256(ticket)) as any;
    if (!row) return false;
    this.db.prepare('DELETE FROM preview_tickets WHERE hash=?').run(row.hash);
    return row.task_id === taskId && row.expires_at >= this.now();
  }

  // ---- share links
  createShare(taskId: number, duration: ShareDuration): { id: number; token: string; expiresAt: number | null } {
    const ttl = SHARE_DURATIONS[duration];
    if (ttl === undefined) throw new Error('duration must be one of 1h, 24h, 7d, never');
    const token = randomToken(24);
    const now = this.now();
    const expiresAt = ttl === null ? null : now + ttl;
    const info = this.db.prepare('INSERT INTO share_links(task_id, token_hash, token_enc, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(taskId, sha256(token), encrypt(this.secret, token), now, expiresAt);
    return { id: Number(info.lastInsertRowid), token, expiresAt };
  }
  private shareFromRow(r: any): ShareLink {
    const active = !r.revoked && (r.expires_at === null || r.expires_at > this.now());
    return { id: r.id, taskId: r.task_id, createdAt: r.created_at, expiresAt: r.expires_at, revoked: !!r.revoked, active };
  }
  listShares(taskId: number): ShareLink[] {
    return (this.db.prepare('SELECT * FROM share_links WHERE task_id=? ORDER BY id DESC').all(taskId) as any[]).map((r) => this.shareFromRow(r));
  }
  getShare(id: number): ShareLink | null {
    const r = this.db.prepare('SELECT * FROM share_links WHERE id=?').get(id);
    return r ? this.shareFromRow(r) : null;
  }
  shareToken(id: number): string | null {
    const r = this.db.prepare('SELECT token_enc FROM share_links WHERE id=?').get(id) as any;
    return r ? decrypt(this.secret, r.token_enc) : null;
  }
  revokeShare(id: number) { this.db.prepare('UPDATE share_links SET revoked=1 WHERE id=?').run(id); }
  /** The share link behind a token of this task, whatever its state (the caller decides what an inactive one means). */
  private findShareByToken(token: string, taskId: number): ShareLink | null {
    const r = this.db.prepare('SELECT * FROM share_links WHERE token_hash=? AND task_id=?').get(sha256(token), taskId);
    return r ? this.shareFromRow(r) : null;
  }
  private inactiveReason(s: ShareLink): 'expired' | 'revoked' { return s.revoked ? 'revoked' : 'expired'; }

  // ---- cookie
  private sign(p: CookiePayload): string {
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update('preview:' + body).digest('base64url')}`;
  }
  private verify(v: string, host: string, taskId: number): { p: CookiePayload } | { reason: 'expired' | 'revoked' | null } {
    const [body, mac] = v.split('.');
    if (!body || !mac) return { reason: null };
    if (!safeEqual(mac, createHmac('sha256', this.secret).update('preview:' + body).digest('base64url'))) return { reason: null };
    let p: CookiePayload;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { reason: null }; }
    if (p.h !== host) return { reason: null };
    if (p.k === 'share') {
      const s = p.s ? this.getShare(p.s) : null;
      if (!s || s.taskId !== taskId) return { reason: null };
      if (!s.active) return { reason: this.inactiveReason(s) };
      if (s.expiresAt === null) return { p };
    }
    if (p.e < this.now()) return { reason: p.k === 'share' ? 'expired' : null };
    return { p };
  }
  private cookieHeaderFor(p: CookiePayload): string {
    const maxAge = Math.max(1, p.e - this.now());
    return `${PREVIEW_COOKIE}=${this.sign(p)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${this.cfg.previewScheme === 'https' ? '; Secure' : ''}`;
  }

  /** Finds the task behind a preview host: `<task>.<project>.<domain>` or `<port>.<task>.<project>.<domain>`. */
  taskForHost(host: string): { id: number; name: string; project: string; alias?: { label: string; publicPaths: string[] } } | null {
    const suffix = '.' + this.cfg.domain;
    if (!host.endsWith(suffix)) return null;
    const labels = host.slice(0, -suffix.length).split('.');
    if (labels.length < 1 || labels.length > 3 || labels.some((l) => !l)) return null;
    // `<alias>` or `<port>.<alias>`: the stable host a project gives to one of its tasks (an alias is never a project name)
    if (labels.length === 1 || (labels.length === 2 && !this.store.getProjectByName(labels[1]))) {
      const label = labels.at(-1)!;
      const pr = this.store.getProjectByAlias(label);
      const t = pr?.aliasTaskId ? this.store.getTask(pr.aliasTaskId) : null;
      if (!pr || !t) return null;
      if (labels.length === 2 && !t.ports.some((x) => x.name === labels[0] && !x.primary)) return null;
      return { id: t.id, name: t.name, project: pr.name, alias: { label, publicPaths: pr.aliasPublicPaths } };
    }
    if (labels.length < 2) return null;
    const [portName, name, project] = labels.length === 3 ? labels : [null, labels[0], labels[1]];
    const p = this.store.getProjectByName(project);
    const t = p ? this.store.getTaskByName(p.id, name) : null;
    if (!t) return null;
    if (portName && !t.ports.some((x) => x.name === portName && !x.primary)) return null;
    return { id: t.id, name: t.name, project };
  }

  /**
   * forwardAuth decision for one request.
   * @param host  X-Forwarded-Host (no port)
   * @param uri   X-Forwarded-Uri (path + query)
   * @param cookieHeader the request's Cookie header
   */
  decide(host: string, uri: string, cookieHeader: string): PreviewDecision {
    const task = this.taskForHost(host.toLowerCase());
    if (!task) return { kind: 'deny', reason: 'no_task' };

    // 1. one-time entry points carried in the URL: swap them for a host-bound cookie, then redirect without the secret
    let url: URL;
    try { url = new URL(uri, 'http://x'); } catch { url = new URL('http://x/'); }
    const parts = cookieHeader.split(';').map((s) => s.trim()).filter(Boolean);
    const rest = parts.filter((p) => !p.startsWith(PREVIEW_COOKIE + '=')).join('; ');
    // paths the owner opened to the world on the project alias (webhooks, OAuth callbacks): no access check, no cookie to the app
    if (task.alias && !/%2[ef5]|%5c|\\|^\/\//i.test(uri.split('?')[0]) && task.alias.publicPaths.some((pp) => (pp.endsWith('/') ? url.pathname.startsWith(pp) : url.pathname === pp))) return { kind: 'allow', cookieHeader: rest };
    const ticket = url.searchParams.get('bv_ticket');
    const share = url.searchParams.get('bv_share');
    if (ticket || share) {
      let payload: CookiePayload | null = null;
      let why: 'expired' | 'revoked' | null = null;
      if (ticket && this.consumeTicket(ticket, task.id)) payload = { h: host.toLowerCase(), k: 'owner', e: this.now() + OWNER_COOKIE_TTL };
      else if (share) {
        const s = this.findShareByToken(share, task.id);
        if (s?.active) payload = { h: host.toLowerCase(), k: 'share', s: s.id, e: s.expiresAt ?? this.now() + 30 * 86400 };
        else if (s) why = this.inactiveReason(s);
      }
      if (!payload) return { kind: 'deny', reason: why ?? 'no_access' };
      url.searchParams.delete('bv_ticket');
      url.searchParams.delete('bv_share');
      return { kind: 'redirect', location: url.pathname + url.search, setCookie: this.cookieHeaderFor(payload) };
    }

    // 2. an existing preview cookie for this host
    const mine = parts.find((p) => p.startsWith(PREVIEW_COOKIE + '='));
    if (mine) {
      const v = this.verify(mine.slice(PREVIEW_COOKIE.length + 1), host.toLowerCase(), task.id);
      // the app must never see our cookie: hand back the rest of the header for Traefik to forward
      if ('p' in v) return { kind: 'allow', cookieHeader: rest };
      if (v.reason) return { kind: 'deny', reason: v.reason };
    }
    return { kind: 'deny', reason: 'no_access' };
  }
}
