import { APP_CREDS } from './helpers.js';

export interface Call { method: string; url: string; body: any; auth: string | null }
/** A fake GitHub: records every call so tests can assert on tokens, scopes and payloads. */
export function mockGithub(o: { users?: Record<string, { id: number; login: string }>; orgMembers?: Record<string, string[]>; repos?: { full_name: string; default_branch: string; private: boolean }[] } = {}) {
  const calls: Call[] = [];
  const users = o.users ?? { gho_julien: { id: 42, login: 'julien' }, gho_bob: { id: 77, login: 'bob' } };
  const impl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = new Headers(init.headers);
    const auth = headers.get('authorization');
    calls.push({ method, url, body, auth });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') return json({ access_token: 'gho_' + body.code });
    if (url === 'https://api.github.com/user') {
      const u = users[(auth ?? '').replace('Bearer ', '')];
      return u ? json({ id: u.id, login: u.login, name: u.login, avatar_url: 'https://avatars.githubusercontent.com/u/' + u.id }) : json({ message: 'Bad credentials' }, 401);
    }
    if (url.startsWith('https://api.github.com/app-manifests/')) {
      return body === null && url.includes('GOODCODE')
        ? json({ id: 99, slug: 'bivouac-abc', name: 'bivouac-abc', client_id: 'Iv1.new', client_secret: 'cs', pem: APP_CREDS.pem, webhook_secret: 'ws', html_url: 'https://github.com/apps/bivouac-abc', owner: { login: 'julien' } }, 201)
        : json({ message: 'Not Found' }, 404);
    }
    if (url.startsWith('https://api.github.com/app/installations') && !url.includes('access_tokens')) return json([{ id: 7, account: { login: 'julien', type: 'User' } }, { id: 8, account: { login: 'acme', type: 'Organization' } }]);
    if (url.endsWith('/access_tokens')) return json({ token: `ghs_${url.split('/').slice(-2)[0]}_${calls.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    if (url.startsWith('https://api.github.com/installation/repositories')) {
      const repos = o.repos ?? [{ full_name: 'julien/demo', default_branch: 'main', private: true }];
      return json({ total_count: repos.length, repositories: repos });
    }
    const org = /^https:\/\/api\.github\.com\/orgs\/([^/]+)$/.exec(url);
    if (org) return org[1] === 'alpic-ai' ? json({ login: 'alpic-ai', type: 'Organization', name: 'Alpic', avatar_url: 'https://avatars.githubusercontent.com/u/1' }) : org[1] === 'limited' ? json({ message: 'rate limit' }, 403) : json({ message: 'Not Found' }, 404);
    const repo = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)(\/pulls)?/.exec(url);
    if (repo && !(auth ?? '').startsWith('Bearer ghs_')) {
      const tok = (auth ?? '').replace('Bearer ', '');
      if (!tok.startsWith('github_pat_')) return json({ message: 'Bad credentials' }, 401);
      if (tok === 'github_pat_otherrepo' || repo[1] !== 'julien/demo') return json({ message: 'Not Found' }, 404);
      if (repo[2]) return tok === 'github_pat_nopulls' ? json({ message: 'Resource not accessible' }, 403) : json([]);
      return json({ default_branch: 'trunk', private: true, permissions: { push: tok !== 'github_pat_readonly', pull: true } });
    }
    const m = /orgs\/([^/]+)\/members\/([^/]+)$/.exec(url);
    if (m) return new Response(null, { status: (o.orgMembers?.[m[1]] ?? []).includes(m[2]) ? 204 : 404 });
    if (url.endsWith('/pulls') && method === 'POST') return json({ html_url: 'https://github.com/julien/demo/pull/1' }, 201);
    return json({ message: 'unmocked ' + url }, 500);
  }) as unknown as typeof fetch;
  return { impl, calls };
}
