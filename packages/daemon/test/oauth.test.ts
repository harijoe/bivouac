import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { matchRedirect } from '../src/oauth.js';
import { makeEnv } from './helpers.js';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function register(env: ReturnType<typeof makeEnv>, redirect = REDIRECT) {
  const r = await env.app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }) });
  return r;
}
async function authorize(env: ReturnType<typeof makeEnv>, clientId: string, challenge: string, decision = 'approve') {
  const params = { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };
  const r = await env.call('POST', '/api/oauth/authorize', { ...params, decision });
  return { status: r.status, body: (await r.json()) as any };
}
const token = (env: ReturnType<typeof makeEnv>, body: Record<string, string>) =>
  env.app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

describe('redirect allow-list', () => {
  const allow = ['https://claude.ai/*', 'https://*.chatgpt.com/*', 'http://localhost:*/*'];
  it('accepts known clients and refuses the rest', () => {
    expect(allow.some((p) => matchRedirect(p, 'https://claude.ai/api/mcp/auth_callback'))).toBe(true);
    expect(allow.some((p) => matchRedirect(p, 'https://sub.chatgpt.com/aip/g-1/oauth/callback'))).toBe(true);
    expect(allow.some((p) => matchRedirect(p, 'http://localhost:54321/callback'))).toBe(true);
    expect(allow.some((p) => matchRedirect(p, 'https://evil.com/claude.ai/'))).toBe(false);
    expect(allow.some((p) => matchRedirect(p, 'https://claude.ai.evil.com/cb'))).toBe(false);
    expect(allow.some((p) => matchRedirect(p, 'https://evilchatgpt.com/cb'))).toBe(false);
    expect(allow.some((p) => matchRedirect(p, 'https://user:pw@claude.ai/cb'))).toBe(false);
    expect(allow.some((p) => matchRedirect(p, 'http://claude.ai/cb'))).toBe(false);
  });
});

describe('oauth server', () => {
  it('publishes spec-conform metadata', async () => {
    const env = makeEnv();
    const pr: any = await (await env.app.request('/.well-known/oauth-protected-resource/mcp')).json();
    expect(pr.resource).toBe('https://1-2-3-4.sslip.io/mcp');
    expect(pr.authorization_servers).toEqual(['https://1-2-3-4.sslip.io']);
    const as: any = await (await env.app.request('/.well-known/oauth-authorization-server')).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('/mcp answers 401 with the resource metadata pointer', async () => {
    const env = makeEnv();
    const r = await env.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="https://1-2-3-4.sslip.io/.well-known/oauth-protected-resource/mcp"');
  });

  it('refuses unknown redirect URIs at registration', async () => {
    const env = makeEnv();
    const r = await register(env, 'https://evil.example/cb');
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe('invalid_redirect_uri');
    expect((await register(env, 'http://localhost:33418/callback')).status).toBe(201);
  });

  it('full flow: PKCE, access token, refresh rotation, reuse detection, revocation', async () => {
    const env = makeEnv();
    const client: any = await (await register(env)).json();
    const { verifier, challenge } = pkce();
    const a = await authorize(env, client.client_id, challenge);
    expect(a.status).toBe(200);
    const redirect = new URL(a.body.redirect);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    const code = redirect.searchParams.get('code')!;

    // wrong verifier → refused (and the code is burned)
    const bad = await token(env, { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(50) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe('invalid_grant');
    const replay = await token(env, { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(replay.status).toBe(400);

    // happy path
    const code2 = new URL((await authorize(env, client.client_id, challenge)).body.redirect).searchParams.get('code')!;
    const ok = await token(env, { grant_type: 'authorization_code', code: code2, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const t1: any = await ok.json();
    expect(t1.token_type).toBe('Bearer'); expect(t1.expires_in).toBe(3600);
    expect(env.ctx.oauth.verifyAccessToken(t1.access_token)?.githubId).toBe(42);
    // tokens are stored hashed
    expect(JSON.stringify(env.store.db.prepare('SELECT * FROM oauth_tokens').all())).not.toContain(t1.access_token);
    expect(JSON.stringify(env.store.db.prepare('SELECT * FROM oauth_tokens').all())).not.toContain(t1.refresh_token);

    // rotation
    const r = await token(env, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
    expect(r.status).toBe(200);
    const t2: any = await r.json();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(env.ctx.oauth.verifyAccessToken(t2.access_token)).not.toBeNull();
    // reusing the old refresh token kills the whole grant
    const reuse = await token(env, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
    expect(reuse.status).toBe(400);
    expect(env.ctx.oauth.verifyAccessToken(t2.access_token)).toBeNull();
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: t2.refresh_token })).status).toBe(400);
  });

  it('access tokens expire after one hour and can be revoked from the dashboard', async () => {
    const env = makeEnv();
    const client: any = await (await register(env)).json();
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(env, client.client_id, challenge)).body.redirect).searchParams.get('code')!;
    const t: any = await (await token(env, { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier })).json();
    expect(env.ctx.oauth.verifyAccessToken(t.access_token)).not.toBeNull();
    const list: any = await (await env.call('GET', '/api/settings')).json();
    expect(list.grants).toHaveLength(1);
    expect(list.grants[0].clientName).toBe('Claude');
    await env.call('DELETE', `/api/settings/grants/${list.grants[0].id}`);
    expect(env.ctx.oauth.verifyAccessToken(t.access_token)).toBeNull();
    expect(((await (await env.call('GET', '/api/settings')).json()) as any).grants).toHaveLength(0);
    // expiry
    const code2 = new URL((await authorize(env, client.client_id, challenge)).body.redirect).searchParams.get('code')!;
    const t2: any = await (await token(env, { grant_type: 'authorization_code', code: code2, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier })).json();
    env.store.db.prepare("UPDATE oauth_tokens SET expires_at = expires_at - 3601 WHERE type='access'").run();
    expect(env.ctx.oauth.verifyAccessToken(t2.access_token)).toBeNull();
  });

  it('requires PKCE S256 and an exact registered redirect URI', async () => {
    const env = makeEnv();
    const client: any = await (await register(env)).json();
    const base = { client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', state: 's' };
    const noPkce = await env.call('GET', '/api/oauth/authorize-info?' + new URLSearchParams(base));
    expect(noPkce.status).toBe(400);
    const plain = await env.call('GET', '/api/oauth/authorize-info?' + new URLSearchParams({ ...base, code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' }));
    expect(plain.status).toBe(400);
    const other = await env.call('GET', '/api/oauth/authorize-info?' + new URLSearchParams({ ...base, redirect_uri: 'https://claude.ai/other', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }));
    expect(other.status).toBe(400);
    const good = await env.call('GET', '/api/oauth/authorize-info?' + new URLSearchParams({ ...base, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }));
    expect(good.status).toBe(200);
    const info: any = await good.json();
    expect(info.client.name).toBe('Claude'); expect(info.redirectHost).toBe('claude.ai'); expect(info.rights.length).toBeGreaterThan(2);
  });

  it('denying sends access_denied; the consent endpoints need a session', async () => {
    const env = makeEnv();
    const client: any = await (await register(env)).json();
    const d = await authorize(env, client.client_id, 'a'.repeat(43), 'deny');
    expect(new URL(d.body.redirect).searchParams.get('error')).toBe('access_denied');
    const anon = await env.app.request('/api/oauth/authorize-info?client_id=x');
    expect(anon.status).toBe(401);
  });
});
