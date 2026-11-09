import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import type { AppEnv, C, Ctx } from './context.js';
import { clientIp } from './context.js';
import { baseUrl } from './config.js';
import { dnsPlan } from '@bivouac/shared';

const DOMAIN_RE = /^(?=.{4,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Setup wizard endpoints: usable with the one-time setup link, or by an administrator. */
export function setupRoutes(app: Hono<AppEnv>, ctx: Ctx) {
  const { cfg, store, auth, gh } = ctx;
  const secure = cfg.previewScheme === 'https';

  app.get('/setup', async (c, next) => {
    const code = c.req.query('code');
    if (code) {
      const wait = ctx.limiter.hit('setup:' + clientIp(c), 10, 15 * 60_000);
      if (wait) return c.text(`Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.`, 429);
      if (auth.checkSetupCode(code)) {
        setCookie(c, 'bv_setup', auth.setupToken(cfg.secretKey), { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 2 * 3600 });
        auth.audit('setup-link', 'setup_link_opened');
      }
    }
    await next();
  });

  const allowed = (c: C) => auth.checkSetupToken(cfg.secretKey, getCookie(c, 'bv_setup')) || c.get('user')?.role === 'admin';
  const guard = async (c: C, next: () => Promise<void>) => {
    if (!allowed(c)) return c.json({ error: 'The setup link is invalid or already used. On the server, run: sudo bivouac reset-admin' }, 401);
    await next();
  };
  app.use('/api/setup/*', async (c, next) => {
    // GitHub redirects here with plain navigations: they are guarded individually below
    return guard(c, next);
  });

  app.get('/api/setup/state', async (c) => {
    const user = c.get('user');
    let repos: { fullName: string }[] = [];
    let installed = false;
    if (gh.configured) {
      try { repos = await gh.listRepos(); installed = repos.length > 0 || (await gh.listInstallations()).length > 0; } catch { /* GitHub unreachable */ }
    }
    return c.json({
      domain: cfg.domain, baseUrl: baseUrl(cfg), publicIp: ctx.publicIp, sslip: cfg.domain.endsWith('.sslip.io'),
      githubConfigured: gh.configured, appSlug: gh.creds?.slug ?? null, installUrl: gh.installUrl(), installed, repoCount: repos.length,
      user, claude: ctx.svc.claudeStatus(), mcpUrl: `${baseUrl(cfg)}/mcp`, setupOpen: auth.setupOpen(),
    });
  });

  // ---- step 1: domain
  const checkDomain = async (domain: string) => {
    if (!DOMAIN_RE.test(domain)) return { ok: false, error: 'This does not look like a domain name. Example: bv.example.com', apex: [], wildcard: [] };
    // A random label every time: a stale or cached answer for a fixed name could not prove the wildcard record exists.
    const probe = `bv-${randomBytes(4).toString('hex')}.${domain}`;
    const [apex, wildcard] = await Promise.all([ctx.resolve4(domain).catch((): string[] => []), ctx.resolve4(probe).catch((): string[] => [])]);
    const ip = ctx.publicIp;
    return { ok: !!ip && apex.includes(ip) && wildcard.includes(ip), apex, wildcard, expected: ip, probe, records: ip ? dnsPlan(domain, ip).records : [] };
  };
  app.post('/api/setup/domain/check', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await checkDomain(String(b.domain ?? '').trim().toLowerCase()));
  });
  app.post('/api/setup/domain/apply', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const domain = String(b.domain ?? '').trim().toLowerCase();
    const r = await checkDomain(domain);
    if (!r.ok) return c.json({ error: (r as { error?: string }).error ?? 'The DNS records are not ready yet.' }, 400);
    changeDomain(ctx, domain);
    const code = String(b.code ?? '');
    return c.json({ redirect: `${baseUrl(cfg)}/setup${code ? `?code=${encodeURIComponent(code)}` : ''}`, domain });
  });
  app.post('/api/setup/domain/reset', (c) => {
    // "keep the sslip.io address" after trying a custom domain
    if (ctx.publicIp) changeDomain(ctx, `${ctx.publicIp.replace(/\./g, '-')}.sslip.io`);
    return c.json({ domain: cfg.domain });
  });

  // ---- step 2: GitHub App (manifest flow)
  app.get('/api/setup/github/org', async (c) => {
    const name = (c.req.query('name') ?? '').trim();
    if (!name) return c.json({ found: false });
    try {
      const o = await gh.publicOrg(name);
      return c.json(o ? { found: true, ...o } : { found: false });
    } catch (e: any) { return c.json({ error: e.message }, 503); }
  });
  app.post('/api/setup/github/manifest', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const org = b.organization ? String(b.organization).trim() : '';
    if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) return c.json({ error: 'Invalid organisation name.' }, 400);
    const state = randomBytes(18).toString('base64url');
    store.setSetting('gh_manifest_state', `${state}:${Math.floor(Date.now() / 1000) + 3600}`);
    const manifest = gh.manifest(baseUrl(cfg), `bivouac-${randomBytes(3).toString('hex')}`);
    const action = org ? `https://github.com/organizations/${org}/settings/apps/new` : 'https://github.com/settings/apps/new';
    return c.json({ action: `${action}?state=${state}`, manifest: JSON.stringify(manifest) });
  });
  app.get('/api/setup/github/created', async (c) => {
    const [state, exp] = (store.getSetting('gh_manifest_state') ?? '').split(':');
    if (!state || state !== c.req.query('state') || Number(exp) < Date.now() / 1000) return c.redirect('/setup?error=github_state');
    store.setSetting('gh_manifest_state', null);
    try {
      gh.save(await gh.convertManifest(c.req.query('code') ?? ''));
    } catch { return c.redirect('/setup?error=github_create'); }
    auth.audit('setup', 'github_app_created', { slug: gh.creds?.slug });
    // connect the person who just created the app: they become the administrator
    return c.redirect('/auth/github/start?next=/setup');
  });
  app.get('/api/setup/github/installed', (c) => {
    auth.audit(c.get('user')?.login ?? 'setup', 'github_app_installed');
    return c.redirect('/setup?step=claude');
  });
  app.post('/api/setup/github/reset', (c) => {
    gh.clear();
    return c.json({ ok: true });
  });
}

/** Switches the public domain. Previews follow; the previous dashboard host keeps working until the next change. */
export function changeDomain(ctx: Ctx, domain: string) {
  if (domain === ctx.cfg.domain) return;
  ctx.store.setSetting('previous_domain', ctx.cfg.domain);
  ctx.store.setSetting('domain', domain);
  ctx.cfg.domain = domain;
  ctx.auth.audit('setup', 'domain_changed', { domain });
}
