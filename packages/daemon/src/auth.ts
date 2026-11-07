import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Store } from './db.js';
import { safeEqual } from './crypto.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const SESSION_DAYS = 30;
const SETUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface User { githubId: number; login: string; name: string | null; avatarUrl: string | null; role: 'admin' | 'user' }
export type AllowKind = 'user' | 'org' | 'team';
export interface AllowEntry { id: number; kind: AllowKind; value: string; label: string | null }

/** Users, sessions, allow-list, setup code, audit log. Everything security-sensitive about "who is this?". */
export class Auth {
  constructor(private store: Store) {}
  private get db() { return this.store.db; }
  private now() { return Math.floor(Date.now() / 1000); }

  // ---- audit
  audit(actor: string, action: string, detail?: unknown) {
    this.db.prepare('INSERT INTO audit(actor, action, detail) VALUES (?,?,?)').run(actor, action, detail === undefined ? null : JSON.stringify(detail));
  }
  listAudit(limit = 100): { id: number; ts: string; actor: string; action: string; detail: any }[] {
    return (this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  // ---- setup code (first installation and `bivouac reset-admin`)
  /** Creates a new single-purpose setup code and returns it (shown once). Reopens the setup wizard. */
  createSetupCode(): string {
    const bytes = randomBytes(8);
    let raw = '';
    for (const b of bytes) raw += SETUP_ALPHABET[b % SETUP_ALPHABET.length];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    this.store.setSetting('setup_code_hash', sha256(code));
    this.audit('system', 'setup_code_created');
    return code;
  }
  setupOpen(): boolean { return this.store.getSetting('setup_code_hash') !== null; }
  checkSetupCode(code: string): boolean {
    const h = this.store.getSetting('setup_code_hash');
    return !!h && safeEqual(h, sha256(String(code).trim().toUpperCase()));
  }
  closeSetup() { this.store.setSetting('setup_code_hash', null); this.audit('system', 'setup_closed'); }
  /** The wizard is reachable without a code only while the instance has no admin and no code was ever created (never: the installer creates it). */
  hasAdmin(): boolean { return !!this.db.prepare("SELECT 1 FROM users WHERE role='admin'").get(); }

  /** Signed, short-lived proof that the setup code was presented (cookie value). */
  setupToken(secret: Buffer): string {
    const exp = this.now() + 2 * 3600;
    const body = `${exp}.${sha256(this.store.getSetting('setup_code_hash') ?? '').slice(0, 16)}`;
    return `${body}.${createHmac('sha256', secret).update('setup:' + body).digest('base64url')}`;
  }
  checkSetupToken(secret: Buffer, tok: string | undefined): boolean {
    if (!tok || !this.setupOpen()) return false;
    const [exp, tag, mac] = tok.split('.');
    if (!exp || !tag || !mac) return false;
    const body = `${exp}.${tag}`;
    const ok = safeEqual(mac, createHmac('sha256', secret).update('setup:' + body).digest('base64url'));
    return ok && Number(exp) > this.now() && tag === sha256(this.store.getSetting('setup_code_hash') ?? '').slice(0, 16);
  }

  // ---- users
  private userFromRow(r: any): User { return { githubId: r.github_id, login: r.login, name: r.name, avatarUrl: r.avatar_url, role: r.role }; }
  getUser(githubId: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE github_id=?').get(githubId);
    return r ? this.userFromRow(r) : null;
  }
  listUsers(): User[] { return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as any[]).map((r) => this.userFromRow(r)); }
  upsertUser(u: { githubId: number; login: string; name?: string | null; avatarUrl?: string | null }, role?: 'admin' | 'user'): User {
    this.db.prepare(`INSERT INTO users(github_id, login, name, avatar_url, role, last_login_at) VALUES(?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(github_id) DO UPDATE SET login=excluded.login, name=excluded.name, avatar_url=excluded.avatar_url, last_login_at=excluded.last_login_at${role ? ', role=excluded.role' : ''}`)
      .run(u.githubId, u.login, u.name ?? null, u.avatarUrl ?? null, role ?? 'user');
    return this.getUser(u.githubId)!;
  }
  removeUser(githubId: number) {
    this.db.prepare('DELETE FROM sessions WHERE github_id=?').run(githubId);
    this.db.prepare("DELETE FROM users WHERE github_id=? AND role<>'admin'").run(githubId);
  }

  // ---- allow-list (GitHub numeric ids, never logins; orgs and teams by name)
  listAllowed(): AllowEntry[] { return this.db.prepare('SELECT * FROM allowlist ORDER BY id').all() as AllowEntry[]; }
  addAllowed(kind: AllowKind, value: string, label?: string) {
    this.db.prepare('INSERT OR IGNORE INTO allowlist(kind, value, label) VALUES (?,?,?)').run(kind, value, label ?? null);
  }
  removeAllowed(id: number) { this.db.prepare('DELETE FROM allowlist WHERE id=?').run(id); }
  isAllowedById(githubId: number): boolean {
    const u = this.getUser(githubId);
    if (u?.role === 'admin') return true;
    return !!this.db.prepare("SELECT 1 FROM allowlist WHERE kind='user' AND value=?").get(String(githubId));
  }

  // ---- sessions
  createSession(githubId: number, kind: 'web' | 'test' = 'web'): string {
    const id = randomToken(32);
    const now = this.now();
    this.db.prepare('INSERT INTO sessions(id_hash, github_id, kind, created_at, expires_at) VALUES (?,?,?,?,?)').run(sha256(id), githubId, kind, now, now + SESSION_DAYS * 86400);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    return id;
  }
  /** Returns the user behind a session id, re-checking that they are still allowed. */
  getSession(id: string | undefined): User | null {
    if (!id) return null;
    const r = this.db.prepare('SELECT github_id, expires_at FROM sessions WHERE id_hash=?').get(sha256(id)) as any;
    if (!r || r.expires_at < this.now()) return null;
    const u = this.getUser(r.github_id);
    if (!u || !this.isAllowedById(u.githubId)) return null;
    return u;
  }
  deleteSession(id: string) { this.db.prepare('DELETE FROM sessions WHERE id_hash=?').run(sha256(id)); }
}

/** Fixed-window limiter with temporary blocking after repeated failures. In memory: resets when the service restarts. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private blocked = new Map<string, number>();
  constructor(private now: () => number = () => Date.now()) {}

  /** Returns seconds to wait when the caller is over the limit, otherwise 0. */
  hit(key: string, limit: number, windowMs: number): number {
    const t = this.now();
    const b = this.blocked.get(key);
    if (b && b > t) return Math.ceil((b - t) / 1000);
    const h = this.hits.get(key);
    if (!h || h.reset <= t) { this.hits.set(key, { n: 1, reset: t + windowMs }); return 0; }
    h.n += 1;
    if (h.n > limit) {
      // temporary block, doubling-free but long enough to make guessing pointless
      this.blocked.set(key, t + windowMs);
      return Math.ceil(windowMs / 1000);
    }
    return 0;
  }
  prune() {
    const t = this.now();
    for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    for (const [k, v] of this.blocked) if (v <= t) this.blocked.delete(k);
  }
}
