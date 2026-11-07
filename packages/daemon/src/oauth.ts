import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import { randomToken, sha256 } from './auth.js';
import { safeEqual } from './crypto.js';

export const ACCESS_TTL = 3600;
export const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 120;
const MAX_CLIENTS = 500;

export class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/** Matches a redirect URI against an allow-list pattern. `*` matches any run of characters except "/" in the host/port part and anything in the path. */
export function matchRedirect(pattern: string, uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  const [pScheme, rest] = pattern.split('://');
  if (u.protocol !== pScheme + ':' || rest === undefined) return false;
  const slash = rest.indexOf('/');
  const pHost = slash < 0 ? rest : rest.slice(0, slash);
  const pPath = slash < 0 ? '/*' : rest.slice(slash);
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const hostRe = new RegExp('^' + esc(pHost).replace(/\*/g, '[^/]*') + '$');
  const pathRe = new RegExp('^' + esc(pPath).replace(/\*/g, '.*') + '$');
  return hostRe.test(u.host) && pathRe.test(u.pathname);
}

export interface OAuthClient { clientId: string; name: string; redirectUris: string[]; createdAt: number }
export interface Grant { id: string; clientId: string; clientName: string; githubId: number; login: string | null; createdAt: number; lastUsedAt: number | null }
export interface TokenInfo { githubId: number; clientId: string; grantId: string }

/** Authorization server for MCP clients: dynamic registration, authorization code + PKCE (S256), rotating refresh tokens. */
export class OAuthServer {
  constructor(private store: Store, private redirectAllow: () => string[]) {}
  private get db() { return this.store.db; }
  private now() { return Math.floor(Date.now() / 1000); }

  // ---- clients
  registerClient(meta: { client_name?: unknown; redirect_uris?: unknown }): OAuthClient {
    const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.map(String) : [];
    if (!uris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required');
    if (uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'too many redirect_uris');
    for (const u of uris) {
      if (!this.redirectAllow().some((p) => matchRedirect(p, u))) {
        throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${u}. Allowed clients: Claude, ChatGPT and local apps (localhost). The admin can extend the list in Settings.`);
      }
    }
    const count = (this.db.prepare('SELECT COUNT(*) n FROM oauth_clients').get() as any).n;
    if (count >= MAX_CLIENTS) {
      this.db.prepare(`DELETE FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_grants) AND created_at < ?`).run(this.now() - 3600);
    }
    const clientId = 'bvc_' + randomToken(18);
    const name = String(meta.client_name ?? 'MCP client').slice(0, 80) || 'MCP client';
    this.db.prepare('INSERT INTO oauth_clients(client_id, name, redirect_uris, created_at) VALUES (?,?,?,?)').run(clientId, name, JSON.stringify(uris), this.now());
    return { clientId, name, redirectUris: uris, createdAt: this.now() };
  }
  getClient(clientId: string): OAuthClient | null {
    const r = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(clientId) as any;
    return r ? { clientId: r.client_id, name: r.name, redirectUris: JSON.parse(r.redirect_uris), createdAt: r.created_at } : null;
  }

  // ---- authorization
  /** Validates an authorization request. Throws a non-redirectable error for a bad client / redirect URI. */
  validateAuthorize(p: Record<string, string | undefined>): { client: OAuthClient; redirectUri: string } {
    const client = p.client_id ? this.getClient(p.client_id) : null;
    if (!client) throw new OAuthError('invalid_client', 'Unknown client. Remove the connector and add it again.');
    const redirectUri = p.redirect_uri ?? '';
    if (!client.redirectUris.includes(redirectUri) || !this.redirectAllow().some((x) => matchRedirect(x, redirectUri))) {
      throw new OAuthError('invalid_request', 'redirect_uri does not match the registered client');
    }
    if (p.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'response_type must be "code"');
    if (!p.code_challenge || p.code_challenge_method !== 'S256') throw new OAuthError('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256');
    if (!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) throw new OAuthError('invalid_request', 'invalid code_challenge');
    return { client, redirectUri };
  }
  /** Called after the signed-in user clicked "Authorize". Returns the code to put in the redirect. */
  issueCode(o: { clientId: string; githubId: number; redirectUri: string; codeChallenge: string; resource?: string }): string {
    const code = randomToken(32);
    this.db.prepare('INSERT INTO oauth_codes(code_hash, client_id, github_id, redirect_uri, code_challenge, resource, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(sha256(code), o.clientId, o.githubId, o.redirectUri, o.codeChallenge, o.resource ?? null, this.now() + CODE_TTL);
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(this.now());
    return code;
  }

  // ---- token endpoint
  private mint(grantId: string) {
    const access = 'bvat_' + randomToken(32), refresh = 'bvrt_' + randomToken(32);
    const t = this.now();
    this.db.prepare('INSERT INTO oauth_tokens(hash, grant_id, type, expires_at) VALUES (?,?,?,?)').run(sha256(access), grantId, 'access', t + ACCESS_TTL);
    this.db.prepare('INSERT INTO oauth_tokens(hash, grant_id, type, expires_at) VALUES (?,?,?,?)').run(sha256(refresh), grantId, 'refresh', t + REFRESH_TTL);
    this.db.prepare('DELETE FROM oauth_tokens WHERE type=\'access\' AND expires_at < ?').run(t - 86400);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'mcp' };
  }
  exchangeCode(p: { code?: string; client_id?: string; redirect_uri?: string; code_verifier?: string }) {
    if (!p.code || !p.code_verifier || !p.client_id) throw new OAuthError('invalid_request', 'code, client_id and code_verifier are required');
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').get(sha256(p.code)) as any;
    // single use: remove it whatever happens next
    this.db.prepare('DELETE FROM oauth_codes WHERE code_hash=?').run(sha256(p.code));
    if (!row || row.expires_at < this.now()) throw new OAuthError('invalid_grant', 'The authorization code is invalid or expired');
    if (row.client_id !== p.client_id) throw new OAuthError('invalid_grant', 'The authorization code was issued to another client');
    if (p.redirect_uri !== undefined && p.redirect_uri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
    const challenge = createHash('sha256').update(p.code_verifier).digest('base64url');
    if (!safeEqual(challenge, row.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
    const grantId = 'g_' + randomToken(12);
    this.db.prepare('INSERT INTO oauth_grants(id, client_id, github_id, created_at) VALUES (?,?,?,?)').run(grantId, row.client_id, row.github_id, this.now());
    return { grantId, githubId: row.github_id as number, tokens: this.mint(grantId) };
  }
  refresh(p: { refresh_token?: string; client_id?: string }) {
    if (!p.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required');
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE hash=? AND type='refresh'").get(sha256(p.refresh_token)) as any;
    if (!row) throw new OAuthError('invalid_grant', 'Unknown refresh token');
    const grant = this.db.prepare('SELECT * FROM oauth_grants WHERE id=?').get(row.grant_id) as any;
    if (!grant || grant.revoked) throw new OAuthError('invalid_grant', 'This connection was revoked. Connect again from your chat app.');
    if (p.client_id && grant.client_id !== p.client_id) throw new OAuthError('invalid_grant', 'refresh token issued to another client');
    if (row.used) {
      // a rotated token came back: assume theft and kill the whole grant
      this.revokeGrant(grant.id);
      throw new OAuthError('invalid_grant', 'Refresh token already used; the connection was revoked for safety. Connect again from your chat app.');
    }
    if (row.expires_at < this.now()) throw new OAuthError('invalid_grant', 'Refresh token expired');
    this.db.prepare('UPDATE oauth_tokens SET used=1 WHERE hash=?').run(row.hash);
    return { grantId: grant.id as string, githubId: grant.github_id as number, tokens: this.mint(grant.id) };
  }

  // ---- bearer check for /mcp
  verifyAccessToken(token: string | undefined): TokenInfo | null {
    if (!token) return null;
    const row = this.db.prepare("SELECT t.expires_at, g.* FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=? AND t.type='access'").get(sha256(token)) as any;
    if (!row || row.revoked || row.expires_at < this.now()) return null;
    this.db.prepare('UPDATE oauth_grants SET last_used_at=? WHERE id=?').run(this.now(), row.id);
    return { githubId: row.github_id, clientId: row.client_id, grantId: row.id };
  }

  // ---- management
  listGrants(): Grant[] {
    return (this.db.prepare(`SELECT g.*, c.name AS client_name, u.login FROM oauth_grants g JOIN oauth_clients c ON c.client_id=g.client_id LEFT JOIN users u ON u.github_id=g.github_id WHERE g.revoked=0 ORDER BY g.created_at DESC`).all() as any[])
      .map((r) => ({ id: r.id, clientId: r.client_id, clientName: r.client_name, githubId: r.github_id, login: r.login, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }
  revokeGrant(id: string) {
    this.db.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').run(id);
    this.db.prepare('DELETE FROM oauth_tokens WHERE grant_id=?').run(id);
  }
  revokeByToken(token: string) {
    const row = this.db.prepare('SELECT grant_id FROM oauth_tokens WHERE hash=?').get(sha256(token)) as any;
    if (row) this.revokeGrant(row.grant_id);
  }
  revokeAllForUser(githubId: number) {
    for (const g of this.db.prepare('SELECT id FROM oauth_grants WHERE github_id=? AND revoked=0').all(githubId) as any[]) this.revokeGrant(g.id);
  }
}
