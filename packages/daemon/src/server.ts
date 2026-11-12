import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppEnv, C, Ctx } from './context.js';
import { clientIp } from './context.js';
import { handleMcp } from './mcp.js';
import { OAuthError } from './oauth.js';
import { randomToken } from './auth.js';
import { baseUrl } from './config.js';
import { apiRoutes } from './routes-api.js';
import { setupRoutes } from './routes-setup.js';
import { buildTraefikConfig } from './routes.js';


export const sessionCookieName = (ctx: Ctx) => (ctx.cfg.previewScheme === 'https' ? '__Host-bv_session' : 'bv_session');
export function setSessionCookie(ctx: Ctx, c: C, id: string) {
  setCookie(c, sessionCookieName(ctx), id, { httpOnly: true, secure: ctx.cfg.previewScheme === 'https', sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
}

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' https://avatars.githubusercontent.com data:", "font-src 'self'",
  "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self' https://github.com",
].join('; ');

export function createApp(ctx: Ctx) {
  const { cfg, auth, oauth, svc } = ctx;
  const app = new Hono<AppEnv>();

  // ---- security headers, session lookup, CSRF guard
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    if (cfg.previewScheme === 'https') c.header('Strict-Transport-Security', 'max-age=31536000');
    if (!c.req.path.startsWith('/mcp') && !c.req.path.startsWith('/oauth/token')) c.header('Content-Security-Policy', CSP);
  });
  app.use('*', async (c, next) => {
    c.set('user', auth.getSession(getCookie(c, sessionCookieName(ctx))));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !c.req.path.startsWith('/oauth/') && !c.req.path.startsWith('/mcp')) {
      // Browsers always send Origin on cross-site and POST requests: refuse anything not coming from the dashboard itself.
      const origin = c.req.header('origin');
      if (origin && origin !== baseUrl(cfg) && !ctx.cfg.testMode) return c.json({ error: 'Cross-origin request refused.' }, 403);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: cfg.version }));

  // ---- login / session
  app.get('/api/session', (c) => {
    const u = c.get('user');
    return c.json({
      user: u, version: cfg.version, domain: cfg.domain, baseUrl: baseUrl(cfg), githubReady: ctx.gh.configured,
      setupOpen: auth.setupOpen(), base: baseUrl(cfg), mcpUrl: `${baseUrl(cfg)}/mcp`,
      // a chat client (Claude, ChatGPT…) has been connected at least once: the home page then shrinks its "connect your chat" block
      mcpConnected: ctx.oauth.listGrants().length > 0,
    });
  });
  app.post('/api/logout', (c) => {
    const id = getCookie(c, sessionCookieName(ctx));
    if (id) auth.deleteSession(id);
    deleteCookie(c, sessionCookieName(ctx), { path: '/', secure: cfg.previewScheme === 'https' });
    return c.json({ ok: true });
  });

  app.get('/auth/github/start', (c) => {
    if (!ctx.gh.configured) return c.redirect('/login?error=github_not_connected');
    const wait = ctx.limiter.hit('login:' + clientIp(c), 30, 60_000);
    if (wait) return c.text(`Too many attempts. Try again in ${wait} seconds.`, 429);
    const state = randomToken(24);
    const next = c.req.query('next') ?? '/';
    setCookie(c, 'bv_gh_state', JSON.stringify({ state, next: /^\/(?![/\\])[^\s]*$/.test(next) ? next : '/' }), { httpOnly: true, sameSite: 'Lax', secure: cfg.previewScheme === 'https', path: '/', maxAge: 600 });
    return c.redirect(ctx.gh.authorizeUrl(`${baseUrl(cfg)}/auth/github/callback`, state));
  });
  app.get('/auth/github/callback', async (c) => {
    const wait = ctx.limiter.hit('login:' + clientIp(c), 30, 60_000);
    if (wait) return c.text(`Too many attempts. Try again in ${wait} seconds.`, 429);
    let saved: { state: string; next: string } | null = null;
    try { saved = JSON.parse(getCookie(c, 'bv_gh_state') ?? 'null'); } catch { /* ignore */ }
    deleteCookie(c, 'bv_gh_state', { path: '/' });
    if (!saved || saved.state !== c.req.query('state') || !c.req.query('code')) return c.redirect('/login?error=state');
    let gu;
    try { gu = await ctx.gh.exchangeUserCode(c.req.query('code')!, `${baseUrl(cfg)}/auth/github/callback`); } catch { return c.redirect('/login?error=github'); }
    const settingUp = auth.checkSetupToken(cfg.secretKey, getCookie(c, 'bv_setup'));
    if (settingUp) {
      // the person who holds the setup link and connected GitHub becomes the administrator; the link is closed for good
      auth.upsertUser({ githubId: gu.id, login: gu.login, name: gu.name, avatarUrl: gu.avatarUrl }, 'admin');
      auth.closeSetup();
      deleteCookie(c, 'bv_setup', { path: '/' });
      auth.audit(gu.login, 'admin_connected', { githubId: gu.id });
    } else if (!(await isAllowed(ctx, gu))) {
      auth.audit(gu.login, 'login_refused', { githubId: gu.id });
      return c.redirect('/login?error=not_allowed');
    } else {
      auth.upsertUser({ githubId: gu.id, login: gu.login, name: gu.name, avatarUrl: gu.avatarUrl });
      auth.addAllowed('user', String(gu.id), gu.login);
    }
    setSessionCookie(ctx, c, auth.createSession(gu.id));
    auth.audit(gu.login, 'login', { githubId: gu.id });
    return c.redirect(settingUp ? '/setup?step=repos' : saved.next);
  });

  setupRoutes(app, ctx);

  // ---- OAuth authorization server for MCP clients
  const metaBase = () => baseUrl(cfg);
  const protectedResource = (c: C) => c.json({ resource: `${metaBase()}/mcp`, authorization_servers: [metaBase()], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: 'bivouac' });
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);
  const asMeta = (c: C) => c.json({
    issuer: metaBase(), authorization_endpoint: `${metaBase()}/oauth/authorize`, token_endpoint: `${metaBase()}/oauth/token`,
    registration_endpoint: `${metaBase()}/oauth/register`, revocation_endpoint: `${metaBase()}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
  });
  app.get('/.well-known/oauth-authorization-server', asMeta);
  app.get('/.well-known/oauth-authorization-server/mcp', asMeta);
  app.get('/.well-known/openid-configuration', asMeta);

  const oauthErr = (c: C, e: unknown) => {
    if (e instanceof OAuthError) return c.json({ error: e.code, error_description: e.message }, e.status as 400);
    throw e;
  };
  app.post('/oauth/register', async (c) => {
    const wait = ctx.limiter.hit('register:' + clientIp(c), 20, 3600_000);
    if (wait) return c.json({ error: 'temporarily_unavailable', error_description: `Too many registrations, retry in ${wait}s` }, 429);
    const body = await c.req.json().catch(() => ({}));
    try {
      const cl = oauth.registerClient(body);
      auth.audit('mcp-client', 'client_registered', { name: cl.name, redirectUris: cl.redirectUris });
      return c.json({
        client_id: cl.clientId, client_name: cl.name, redirect_uris: cl.redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none', client_id_issued_at: cl.createdAt,
      }, 201);
    } catch (e) { return oauthErr(c, e); }
  });
  // consent screen data and decision (the page itself is part of the dashboard app)
  app.get('/api/oauth/authorize-info', (c) => {
    const u = c.get('user');
    if (!u) return c.json({ error: 'unauthorized' }, 401);
    try {
      const { client, redirectUri } = oauth.validateAuthorize(c.req.query() as Record<string, string>);
      return c.json({ client: { name: client.name, id: client.clientId }, redirectHost: new URL(redirectUri).host, user: u.login, scope: 'mcp',
        rights: ['See your projects and tasks', 'Create, stop and resume tasks', 'Create and revoke preview share links', 'Push branches and open pull requests'] });
    } catch (e) { return oauthErr(c, e); }
  });
  app.post('/api/oauth/authorize', async (c) => {
    const u = c.get('user');
    if (!u) return c.json({ error: 'unauthorized' }, 401);
    const p = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    try {
      const { client, redirectUri } = oauth.validateAuthorize(p);
      const dest = new URL(redirectUri);
      if (String(p.decision) !== 'approve') {
        dest.searchParams.set('error', 'access_denied');
        if (p.state) dest.searchParams.set('state', p.state);
        auth.audit(u.login, 'mcp_client_denied', { client: client.name });
        return c.json({ redirect: dest.toString() });
      }
      const code = oauth.issueCode({ clientId: client.clientId, githubId: u.githubId, redirectUri, codeChallenge: p.code_challenge, resource: p.resource });
      dest.searchParams.set('code', code);
      if (p.state) dest.searchParams.set('state', p.state);
      auth.audit(u.login, 'mcp_client_authorized', { client: client.name });
      return c.json({ redirect: dest.toString() });
    } catch (e) { return oauthErr(c, e); }
  });
  app.post('/oauth/token', async (c) => {
    const wait = ctx.limiter.hit('token:' + clientIp(c), 120, 60_000);
    if (wait) return c.json({ error: 'temporarily_unavailable', error_description: `Retry in ${wait}s` }, 429);
    const ct = c.req.header('content-type') ?? '';
    const raw = ct.includes('json') ? await c.req.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await c.req.text()));
    const p = raw as Record<string, string>;
    c.header('Cache-Control', 'no-store');
    try {
      if (p.grant_type === 'authorization_code') return c.json(oauth.exchangeCode(p).tokens);
      if (p.grant_type === 'refresh_token') return c.json(oauth.refresh(p).tokens);
      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    } catch (e) { return oauthErr(c, e); }
  });
  app.post('/oauth/revoke', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    const p = (ct.includes('json') ? await c.req.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await c.req.text()))) as Record<string, string>;
    if (p.token) oauth.revokeByToken(p.token);
    return c.body(null, 200);
  });

  // ---- MCP endpoint
  app.all('/mcp', async (c) => {
    const unauthorized = () => c.json({ error: 'unauthorized', error_description: 'Authorization required' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${metaBase()}/.well-known/oauth-protected-resource/mcp"`,
    });
    const h = c.req.header('authorization');
    const info = h?.toLowerCase().startsWith('bearer ') ? oauth.verifyAccessToken(h.slice(7).trim()) : null;
    if (!info) return unauthorized();
    const user = auth.getUser(info.githubId);
    if (!user || !auth.isAllowedById(user.githubId)) return unauthorized();
    const client = oauth.getClient(info.clientId);
    return handleMcp(svc, { kind: 'mcp', label: `mcp:${client?.name ?? info.clientId}:${user.login}` }, c.req.raw);
  });

  apiRoutes(app, ctx);

  // ---- dashboard (static files, SPA fallback)
  const dir = cfg.dashboardDir;
  if (dir && existsSync(dir)) {
    const index = () => readFileSync(path.join(dir, 'index.html'), 'utf8');
    app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), dir) || '.' }));
    app.get('/favicon.svg', serveStatic({ root: path.relative(process.cwd(), dir) || '.' }));
    app.get('/theme-init.js', serveStatic({ root: path.relative(process.cwd(), dir) || '.' }));
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/.well-known/')) return c.json({ error: 'not found' }, 404);
      c.header('Cache-Control', 'no-store');
      return c.html(index());
    });
  }
  return app;
}

/** Is this GitHub account allowed in? By numeric id, or as a member of an allowed organisation / team. */
export async function isAllowed(ctx: Ctx, gu: { id: number; login: string }): Promise<boolean> {
  if (ctx.auth.isAllowedById(gu.id)) return true;
  for (const e of ctx.auth.listAllowed()) {
    try {
      if (e.kind === 'org' && (await ctx.gh.isMemberOfOrg(gu.login, e.value))) return true;
      if (e.kind === 'team') { const [org, team] = e.value.split('/'); if (await ctx.gh.isMemberOfTeam(gu.login, org, team)) return true; }
    } catch { /* GitHub unreachable: stay closed */ }
  }
  return false;
}

/** Internal listener: Traefik's dynamic configuration and the preview forwardAuth. Never exposed through Traefik. */
export function createInternalApp(ctx: Ctx) {
  const app = new Hono();
  app.get('/internal/health', (c) => c.json({ ok: true }));
  app.get('/internal/traefik', (c) => {
    const cfg = { ...ctx.cfg };
    const conf = buildTraefikConfig(cfg, ctx.store.routeTasks());
    const prev = ctx.store.getSetting('previous_domain');
    if (prev && prev !== cfg.domain) {
      const r = conf.http.routers['bivouac-web'];
      r.rule = `Host(\`${cfg.domain}\`) || Host(\`${prev}\`)`;
    }
    return c.json(conf);
  });
  app.get('/internal/preview-auth', (c) => {
    const host = (c.req.header('x-forwarded-host') ?? '').split(':')[0];
    const uri = c.req.header('x-forwarded-uri') ?? '/';
    const d = ctx.previews.decide(host, uri, c.req.header('cookie') ?? '');
    if (d.kind === 'allow') {
      // Traefik copies this header over the request's Cookie header: the preview cookie never reaches the app
      return c.body(null, 200, { Cookie: d.cookieHeader });
    }
    if (d.kind === 'redirect') {
      // Traefik resolves a relative Location against the auth service's own address: send an absolute URL on the public host.
      const proto = c.req.header('x-forwarded-proto') ?? ctx.cfg.previewScheme;
      const fullHost = c.req.header('x-forwarded-host') ?? host;
      return c.body(null, 302, { Location: `${proto}://${fullHost}${d.location}`, 'Set-Cookie': d.setCookie, 'Cache-Control': 'no-store' });
    }
    const dash = baseUrl(ctx.cfg);
    const gone = d.reason === 'no_task';
    const lapsed = d.reason === 'expired' || d.reason === 'revoked';
    const title = gone ? 'Preview not found' : lapsed ? (d.reason === 'expired' ? 'This link has expired' : 'This link was revoked') : 'Access denied';
    const msg = gone ? 'This preview does not exist (anymore).' : d.reason === 'expired' ? 'The share link you used is no longer valid because its time ran out.' : d.reason === 'revoked' ? 'The owner turned this share link off.' : 'This preview is private.';
    const hint = gone ? 'The task may have been renamed or deleted. Ask the person who sent you the link for a new one.' : lapsed ? 'Ask the person who sent you the link for a new one.' : 'Ask the owner for a share link, or open the preview from your bivouac dashboard.';
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#14181f}@media(prefers-color-scheme:dark){body{background:#0e1116;color:#e6e9ee}a{color:#7fb0ff}}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:.5rem 0}p{margin:.5rem 0;opacity:.8}</style></head>
<body><main><div style="font-size:2.5rem">${lapsed ? '⏳' : '🔒'}</div><h1>${title}</h1><p>${msg}</p><p>${hint}</p><p><a href="${dash}">Open the dashboard</a></p></main></body></html>`, gone ? 404 : 403, { 'Cache-Control': 'no-store' });
  });
  return app;
}

