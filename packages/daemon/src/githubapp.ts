import { createSign } from 'node:crypto';
import type { Store } from './db.js';
import { randomToken } from './auth.js';

export interface GithubAppCreds {
  id: number; slug: string; name: string; clientId: string; clientSecret: string; pem: string; webhookSecret: string; htmlUrl: string; ownerLogin: string;
}
export interface RepoInfo { fullName: string; defaultBranch: string; private: boolean; installationId: number; pushedAt?: string | null; owner?: string; }

type F = typeof fetch;
const API = 'https://api.github.com';
const H = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bivouac' };

/** Permissions requested from GitHub for git operations, per access level (always limited to one repository). */
export const PERMS = {
  read: { contents: 'read', metadata: 'read' },
  write: { contents: 'write', pull_requests: 'write', metadata: 'read' },
} as const;

export class GithubError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

/** This instance's own GitHub App: manifest flow, login, installation tokens. `fetchImpl` is injectable for tests. */
export class GithubApp {
  private tokenCache = new Map<string, { token: string; exp: number }>();
  constructor(private store: Store, private fetchImpl: F = fetch) {}

  get creds(): GithubAppCreds | null {
    const raw = this.store.getSecretSetting('github_app');
    return raw ? (JSON.parse(raw) as GithubAppCreds) : null;
  }
  get configured() { return this.creds !== null; }
  save(c: GithubAppCreds) { this.store.setSecretSetting('github_app', JSON.stringify(c)); this.tokenCache.clear(); }
  clear() { this.store.setSecretSetting('github_app', null); this.tokenCache.clear(); }

  // ---- manifest flow
  /** The manifest GitHub needs to create a private app for this instance. */
  manifest(baseUrl: string, name: string) {
    return {
      name,
      url: baseUrl,
      hook_attributes: { url: `${baseUrl}/webhooks/github`, active: false },
      redirect_url: `${baseUrl}/api/setup/github/created`,
      callback_urls: [`${baseUrl}/auth/github/callback`],
      setup_url: `${baseUrl}/api/setup/github/installed`,
      setup_on_update: true,
      public: false,
      request_oauth_on_install: false,
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', members: 'read' },
      default_events: [] as string[],
    };
  }
  async convertManifest(code: string): Promise<GithubAppCreds> {
    const r = await this.fetchImpl(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: H });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new GithubError(`GitHub refused the app creation code (${r.status}: ${j.message ?? 'error'}). Start the GitHub step again.`, r.status);
    return { id: j.id, slug: j.slug, name: j.name, clientId: j.client_id, clientSecret: j.client_secret, pem: j.pem, webhookSecret: j.webhook_secret, htmlUrl: j.html_url, ownerLogin: j.owner?.login ?? '' };
  }

  // ---- app-level (JWT) calls
  jwt(): string {
    const c = this.creds;
    if (!c) throw new GithubError('GitHub is not connected yet. Open Settings > GitHub and connect it.');
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: c.clientId })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(c.pem).toString('base64url')}`;
  }
  private async call(path: string, o: { method?: string; auth: string; body?: unknown }) {
    const r = await this.fetchImpl(path.startsWith('http') ? path : API + path, {
      method: o.method ?? 'GET', headers: { ...H, Authorization: `Bearer ${o.auth}`, ...(o.body ? { 'Content-Type': 'application/json' } : {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new GithubError(`GitHub API ${r.status}: ${j.message ?? 'error'}`, r.status);
    return j;
  }
  // ---- public / token lookups
  /** A GitHub organisation by name, through the public API (no authentication). Null when it does not exist. */
  async publicOrg(name: string): Promise<{ login: string; name: string | null; avatarUrl: string | null } | null> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(name)) return null;
    const r = await this.fetchImpl(`${API}/orgs/${encodeURIComponent(name)}`, { headers: H });
    if (r.status === 404) return null;
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 403 || r.status === 429) throw new GithubError('GitHub is limiting lookups from this server for a few minutes. Try again shortly.', r.status);
    if (!r.ok || j.type !== 'Organization') {
      if (r.ok) return null; // a user account, not an organisation
      throw new GithubError(`GitHub answered ${r.status}. Try again.`, r.status);
    }
    return { login: j.login, name: j.name ?? null, avatarUrl: j.avatar_url ?? null };
  }

  /**
   * Checks that a fine-grained token really gives bivouac what it needs on one repository: it can see it, read and
   * write its contents, and use pull requests. Throws an error that says which permission to fix.
   */
  async checkRepoToken(fullName: string, token: string): Promise<{ defaultBranch: string; private: boolean }> {
    const get = async (path: string) => {
      const r = await this.fetchImpl(`${API}${path}`, { headers: { ...H, Authorization: `Bearer ${token}` } });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    const repo = await get(`/repos/${fullName}`);
    if (repo.status === 401) throw new GithubError('GitHub rejected this token: it is wrong, expired or revoked. Create a new one and paste it again.', 401);
    if (repo.status === 404 || repo.status === 403) throw new GithubError(`This token cannot access ${fullName}. When creating it, choose “Only select repositories” and pick this one (and check the repository name).`, repo.status);
    if (repo.status !== 200) throw new GithubError(`GitHub answered ${repo.status} when checking the repository. Try again.`, repo.status);
    if (repo.body.permissions && !repo.body.permissions.push) throw new GithubError('This token can only read the repository. Give it “Contents: Read and write” so the agent can push its branch.', 403);
    const pulls = await get(`/repos/${fullName}/pulls?per_page=1`);
    if (pulls.status === 403 || pulls.status === 404) throw new GithubError('This token cannot use pull requests. Give it “Pull requests: Read and write”.', 403);
    return { defaultBranch: repo.body.default_branch ?? 'main', private: !!repo.body.private };
  }

  async listInstallations(): Promise<{ id: number; account: string; accountType: string }[]> {
    const j = await this.call('/app/installations?per_page=100', { auth: this.jwt() });
    return (j as any[]).map((i) => ({ id: i.id, account: i.account?.login, accountType: i.account?.type }));
  }
  /** Short-lived token for one installation, optionally narrowed to a repository and permissions. */
  async installationToken(installationId: number, o: { repo?: string; access?: 'read' | 'write' } = {}): Promise<string> {
    const key = `${installationId}:${o.repo ?? '*'}:${o.access ?? '*'}`;
    const hit = this.tokenCache.get(key);
    if (hit && hit.exp - Date.now() > 5 * 60_000) return hit.token;
    const body: any = {};
    if (o.repo) body.repositories = [o.repo.split('/').pop()];
    if (o.access) body.permissions = PERMS[o.access];
    const j = await this.call(`/app/installations/${installationId}/access_tokens`, { method: 'POST', auth: this.jwt(), body });
    this.tokenCache.set(key, { token: j.token, exp: Date.parse(j.expires_at) });
    return j.token as string;
  }
  async listRepos(): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    for (const inst of await this.listInstallations()) {
      const tok = await this.installationToken(inst.id);
      for (let page = 1; page <= 10; page++) {
        const j = await this.call(`/installation/repositories?per_page=100&page=${page}`, { auth: tok });
        for (const r of j.repositories ?? []) out.push({ fullName: r.full_name, defaultBranch: r.default_branch, private: !!r.private, installationId: inst.id, pushedAt: r.pushed_at ?? null, owner: r.owner?.login ?? String(r.full_name).split('/')[0] });
        if ((j.repositories ?? []).length < 100) break;
      }
    }
    // most recently pushed first: what the user is working on comes up first
    return out.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '') || a.fullName.localeCompare(b.fullName));
  }
  installUrl(): string | null {
    const c = this.creds;
    return c ? `https://github.com/apps/${c.slug}/installations/new` : null;
  }

  // ---- user login (GitHub App user authorization)
  authorizeUrl(redirectUri: string, state: string): string {
    const c = this.creds;
    if (!c) throw new GithubError('GitHub is not connected yet.');
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', c.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    return u.toString();
  }
  async exchangeUserCode(code: string, redirectUri: string): Promise<{ id: number; login: string; name: string | null; avatarUrl: string | null }> {
    const c = this.creds;
    if (!c) throw new GithubError('GitHub is not connected yet.');
    const r = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'bivouac' },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirectUri }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new GithubError(`GitHub login failed (${j.error_description ?? j.error ?? r.status}). Try signing in again.`, r.status);
    const u = await this.call('/user', { auth: j.access_token });
    return { id: u.id, login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url ?? null };
  }

  // ---- organisation / team membership (uses an installation token, needs the "Members" read permission)
  async isMemberOfOrg(login: string, org: string): Promise<boolean> {
    for (const inst of await this.listInstallations()) {
      if (inst.account.toLowerCase() !== org.toLowerCase()) continue;
      const tok = await this.installationToken(inst.id);
      const r = await this.fetchImpl(`${API}/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`, { headers: { ...H, Authorization: `Bearer ${tok}` }, redirect: 'manual' });
      return r.status === 204;
    }
    return false;
  }
  async isMemberOfTeam(login: string, org: string, team: string): Promise<boolean> {
    for (const inst of await this.listInstallations()) {
      if (inst.account.toLowerCase() !== org.toLowerCase()) continue;
      const tok = await this.installationToken(inst.id);
      const r = await this.fetchImpl(`${API}/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`, { headers: { ...H, Authorization: `Bearer ${tok}` } });
      if (!r.ok) return false;
      const j: any = await r.json().catch(() => ({}));
      return j.state === 'active';
    }
    return false;
  }
}

export const newState = () => randomToken(24);
