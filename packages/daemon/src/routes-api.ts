import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { parseProjectConfig, type Task } from '@bivouac/shared';
import type { AppEnv, C, Ctx } from './context.js';
import { baseUrl } from './config.js';
import { loginState } from './claude.js';
import type { StoreMessage } from './db.js';
import { changeDomain } from './routes-setup.js';
import { UserError, type Actor } from './service.js';
import type { ShareDuration } from './preview.js';

const param = (c: C, k: string) => c.req.param(k) as string;

export function apiRoutes(app: Hono<AppEnv>, ctx: Ctx) {
  const { cfg, store, svc, auth, oauth, previews } = ctx;
  const secure = cfg.previewScheme === 'https';
  void secure;

  // everything below needs a signed-in, allowed user
  app.use('/api/*', async (c, next) => {
    if (!c.get('user')) return c.json({ error: 'Sign in to continue.', code: 'unauthorized' }, 401);
    await next();
  });

  const actorOf = (c: C): Actor => ({ kind: 'user', label: c.get('user')!.login });
  const admin = (c: C) => {
    if (c.get('user')!.role !== 'admin') throw new UserError('Only an administrator can do this.', 'forbidden', 400);
  };
  const run = (fn: (c: C) => Promise<Response> | Response) => async (c: C) => {
    try { return await fn(c); } catch (e: any) {
      if (e instanceof UserError) return c.json({ error: e.message, code: e.code }, e.code === 'forbidden' ? 403 : e.status);
      if (e?.code === 'UNPUSHED') return c.json({ error: e.message, code: 'UNPUSHED', unpushed: e.unpushed }, 409);
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  };
  const taskOf = (c: C): Task => {
    const t = store.getTask(Number(param(c, 'id')));
    if (!t) throw new UserError('This task does not exist (anymore).', 'unknown_task', 404);
    return t;
  };
  const view = (t: Task) => ({ ...t, dashboardUrl: svc.taskUrl(t), pendingInstructions: store.pendingInstructionCount(t.id), active: ctx.mgr.isActive(t.id) });

  app.get('/api/totals', (c) => c.json(store.totals()));

  // ---- projects
  app.get('/api/projects', (c) => c.json(svc.listProjects()));
  app.get('/api/github/repos', run(async (c) => {
    admin(c);
    if (!ctx.gh.configured) return c.json({ configured: false, repos: [], installUrl: null });
    const taken = new Set(store.listProjects().map((p) => p.githubRepo?.toLowerCase()));
    const repos = (await ctx.gh.listRepos()).map((r) => ({ ...r, added: taken.has(r.fullName.toLowerCase()) }));
    return c.json({ configured: true, repos, installUrl: ctx.gh.installUrl() });
  }));
  app.post('/api/projects', run(async (c) => {
    admin(c);
    const b = await c.req.json().catch(() => ({}));
    if (b.repoUrl) return c.json(await svc.addTokenProject({ repoUrl: String(b.repoUrl), token: b.githubToken || null, name: b.name, defaultBranch: b.defaultBranch }, actorOf(c)), 201);
    return c.json(await svc.addGithubProject({ fullName: String(b.fullName ?? ''), name: b.name }, actorOf(c)), 201);
  }));
  app.patch('/api/projects/:id', run(async (c) => {
    admin(c);
    const p = store.getProject(Number(param(c, 'id')));
    if (!p) throw new UserError('This project does not exist.', 'unknown_project', 404);
    const b = await c.req.json().catch(() => ({}));
    let config;
    if (b.config !== undefined) { try { config = typeof b.config === 'string' ? parseProjectConfig(b.config) : b.config; } catch (e: any) { throw new UserError(e.message); } }
    store.updateProject(p.id, { config, githubToken: b.githubToken, defaultBranch: b.defaultBranch });
    return c.json(store.getProject(p.id));
  }));
  app.delete('/api/projects/:id', run((c) => {
    admin(c);
    const id = Number(param(c, 'id'));
    if (store.listTasks(id).length) throw new UserError('Delete or archive the tasks of this project first.', 'has_tasks', 409);
    store.deleteProject(id);
    auth.audit(actorOf(c).label, 'project_deleted', { id });
    return c.json({ ok: true });
  }));

  // ---- tasks (creation happens through MCP: the dashboard follows, stops and configures)
  app.get('/api/tasks', (c) => {
    const p = c.req.query('project');
    return c.json(store.listTasks(p ? Number(p) : undefined).map(view));
  });
  app.get('/api/projects/:project/tasks/:task', run((c) => {
    const t = svc.resolveTask(param(c, 'project'), param(c, 'task'));
    return c.json(view(t));
  }));
  app.get('/api/tasks/:id', run((c) => c.json({ ...view(taskOf(c)), shares: shareList(taskOf(c)) })));
  const shareList = (t: Task) => previews.listShares(t.id).map((s) => ({ ...s, url: s.active ? svc.shareUrl(t, previews.shareToken(s.id) ?? '') : null }));
  app.get('/api/tasks/:id/events', run((c) => c.json(store.listEvents(taskOf(c).id, Number(c.req.query('after') ?? 0)))));
  app.get('/api/tasks/:id/devlogs', run(async (c) => c.json({ text: await ctx.mgr.devLogs(taskOf(c).id, Number(c.req.query('lines') ?? 200)) })));
  app.post('/api/tasks/:id/stop', run(async (c) => c.json(view(await svc.stopTask(taskOf(c), actorOf(c))))));
  app.post('/api/tasks/:id/resume', run(async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(view(await svc.resumeTask(taskOf(c), actorOf(c), b.text)));
  }));
  app.post('/api/tasks/:id/instruct', run(async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await svc.instruct(taskOf(c), String(b.text ?? ''), actorOf(c)));
  }));
  app.post('/api/tasks/:id/rename', run(async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(view(svc.renameTask(taskOf(c), String(b.name ?? ''), actorOf(c))));
  }));
  app.patch('/api/tasks/:id', run(async (c) => {
    const t = taskOf(c);
    const b = await c.req.json().catch(() => ({}));
    store.patchTask(t.id, { maxCostUsd: b.maxCostUsd, maxIterations: b.maxIterations, maxTokens: b.maxTokens });
    return c.json(view(store.getTask(t.id)!));
  }));
  app.post('/api/tasks/:id/push', run(async (c) => c.json(view(await svc.pushBranch(taskOf(c), actorOf(c))))));
  app.post('/api/tasks/:id/pr', run(async (c) => c.json({ url: await svc.openPr(taskOf(c), actorOf(c)) })));
  app.delete('/api/tasks/:id', run(async (c) => { await svc.deleteTask(taskOf(c), c.req.query('force') === '1', actorOf(c)); return c.json({ ok: true }); }));
  app.post('/api/tasks/:id/preview-link', run(async (c) => {
    const t = taskOf(c);
    if (!t.devPort) throw new UserError('This task has no preview yet: it is still starting.', 'no_preview');
    const b = await c.req.json().catch(() => ({}));
    return c.json({ url: svc.ownerPreviewUrl(t, typeof b.port === 'string' ? b.port : undefined) });
  }));
  app.post('/api/tasks/:id/shares', run(async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const d = String(b.duration ?? '24h') as ShareDuration;
    return c.json(svc.createShareLink(taskOf(c), d, actorOf(c)), 201);
  }));
  app.delete('/api/tasks/:id/shares/:sid', run((c) => { svc.revokeShareLink(taskOf(c), Number(param(c, 'sid')), actorOf(c)); return c.json({ ok: true }); }));

  // ---- settings
  app.get('/api/settings', run((c) => {
    const isAdmin = c.get('user')!.role === 'admin';
    return c.json({
      admin: isAdmin, baseUrl: baseUrl(cfg), domain: cfg.domain, sslip: cfg.domain.endsWith('.sslip.io'), publicIp: ctx.publicIp, mcpUrl: `${baseUrl(cfg)}/mcp`, version: process.env.BIVOUAC_VERSION ?? 'dev',
      claude: svc.claudeStatus(),
      github: { configured: ctx.gh.configured, slug: ctx.gh.creds?.slug ?? null, installUrl: ctx.gh.installUrl(), appUrl: ctx.gh.creds?.htmlUrl ?? null },
      budgets: { maxIterations: Number(store.getSetting('default_max_iterations') ?? 0) || null, maxCostUsd: Number(store.getSetting('default_max_cost_usd') ?? 0) || null },
      users: isAdmin ? auth.listUsers() : [], allowlist: isAdmin ? auth.listAllowed() : [],
      redirectAllow: isAdmin ? cfg.oauthRedirectAllow : [],
      grants: oauth.listGrants().map((g) => ({ ...g, createdAt: new Date(g.createdAt * 1000).toISOString(), lastUsedAt: g.lastUsedAt ? new Date(g.lastUsedAt * 1000).toISOString() : null })),
    });
  }));
  app.put('/api/settings/budgets', run(async (c) => {
    admin(c);
    const b = await c.req.json().catch(() => ({}));
    const n = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number(v));
    for (const [k, v] of [['default_max_iterations', n(b.maxIterations)], ['default_max_cost_usd', n(b.maxCostUsd)]] as const) {
      if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new UserError('Budgets must be positive numbers.');
      store.setSetting(k, v === null ? null : String(v));
    }
    return c.json({ ok: true });
  }));
  app.post('/api/settings/allowlist', run(async (c) => {
    admin(c);
    const b = await c.req.json().catch(() => ({}));
    const kind = String(b.kind);
    const value = String(b.value ?? '').trim();
    if (kind === 'user') {
      // accept a numeric id, or a login that we resolve to the permanent numeric id
      let id = /^\d+$/.test(value) ? Number(value) : 0, login = String(b.label ?? value);
      if (!id) {
        const r = await fetch(`https://api.github.com/users/${encodeURIComponent(value.replace(/^@/, ''))}`, { headers: { 'User-Agent': 'bivouac' } }).catch(() => null);
        const j: any = r?.ok ? await r.json() : null;
        if (!j?.id) throw new UserError(`GitHub user "${value}" was not found. Check the spelling, or enter their numeric GitHub id.`);
        id = j.id; login = j.login;
      }
      auth.addAllowed('user', String(id), login);
    } else if (kind === 'org' && /^[A-Za-z0-9-]{1,39}$/.test(value)) auth.addAllowed('org', value, value);
    else if (kind === 'team' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_-]{1,100}$/.test(value)) auth.addAllowed('team', value, value);
    else throw new UserError('Enter a GitHub login, an organisation name, or a team as "organisation/team-slug".');
    auth.audit(actorOf(c).label, 'allowlist_added', { kind, value });
    return c.json({ allowlist: auth.listAllowed() });
  }));
  app.delete('/api/settings/allowlist/:id', run((c) => {
    admin(c);
    const e = auth.listAllowed().find((x) => x.id === Number(param(c, 'id')));
    auth.removeAllowed(Number(param(c, 'id')));
    if (e?.kind === 'user') { auth.removeUser(Number(e.value)); oauth.revokeAllForUser(Number(e.value)); }
    auth.audit(actorOf(c).label, 'allowlist_removed', { entry: e });
    return c.json({ allowlist: auth.listAllowed() });
  }));
  app.get('/api/settings/audit', run((c) => { admin(c); return c.json(auth.listAudit(Number(c.req.query('limit') ?? 100))); }));
  app.delete('/api/settings/grants/:id', run((c) => {
    oauth.revokeGrant(param(c, 'id'));
    auth.audit(actorOf(c).label, 'mcp_client_revoked', { grant: param(c, 'id') });
    return c.json({ ok: true });
  }));
  // Changing the domain recreates the GitHub App (its URLs are bound to the domain) and asks to reconnect the MCP connector.
  app.post('/api/settings/domain', run(async (c) => {
    admin(c);
    const b = await c.req.json().catch(() => ({}));
    const domain = String(b.domain ?? '').trim().toLowerCase();
    const ip = ctx.publicIp;
    const [apex, wild] = await Promise.all([ctx.resolve4(domain).catch((): string[] => []), ctx.resolve4('bv-dns-check.' + domain).catch((): string[] => [])]);
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain) || !ip || !apex.includes(ip) || !wild.includes(ip)) {
      throw new UserError(`The DNS records for ${domain || 'this domain'} are not ready. Create an A record for the domain and one for *.${domain || 'domain'} pointing to ${ip ?? 'this server'}, then try again.`);
    }
    changeDomain(ctx, domain);
    ctx.gh.clear();
    for (const g of oauth.listGrants()) oauth.revokeGrant(g.id);
    const code = auth.createSetupCode();
    return c.json({ redirect: `${baseUrl(cfg)}/setup?code=${code}`, domain });
  }));

  // ---- Claude connection (claude setup-token in a throwaway container)
  const needLogin = () => { if (!ctx.login) throw new UserError('The executor service is not available. Check the bivouac containers on the server.', 'executor_down', 502); return ctx.login; };
  app.get('/api/claude', (c) => c.json(svc.claudeStatus()));
  app.post('/api/claude/login', run(async (c) => { admin(c); const s = await needLogin().loginStart(); return c.json({ id: s.id }); }));
  app.get('/api/claude/login/:id', run(async (c) => {
    admin(c);
    const l = needLogin();
    const s = await l.loginGet(param(c, 'id'));
    const st = loginState(s.output, s.done, s.exitCode);
    if (st.phase === 'done' && st.token) {
      store.setSecretSetting('claude_oauth_token', st.token);
      store.setSetting('claude_token_at', new Date().toISOString());
      auth.audit(actorOf(c).label, 'claude_connected', { kind: 'oauth' });
      await l.loginCancel(s.id).catch(() => {});
      return c.json({ phase: 'done' });
    }
    return c.json({ phase: st.phase, url: st.url, message: st.message });
  }));
  app.post('/api/claude/login/:id/code', run(async (c) => {
    admin(c);
    const b = await c.req.json().catch(() => ({}));
    const code = String(b.code ?? '').trim();
    if (!code || /[\r\n]/.test(code) || code.length > 500) throw new UserError('Paste the code shown on claude.ai.');
    await needLogin().loginInput(param(c, 'id'), code);
    return c.json({ ok: true });
  }));
  app.delete('/api/claude/login/:id', run(async (c) => { admin(c); await needLogin().loginCancel(param(c, 'id')).catch(() => {}); return c.json({ ok: true }); }));
  app.put('/api/claude/apikey', run(async (c) => {
    admin(c);
    const b = await c.req.json().catch(() => ({}));
    const key = String(b.key ?? '').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new UserError('This does not look like an Anthropic API key (it starts with sk-ant-).');
    store.setSecretSetting('anthropic_api_key', key);
    store.setSecretSetting('claude_oauth_token', null);
    auth.audit(actorOf(c).label, 'claude_connected', { kind: 'apikey' });
    return c.json({ ok: true });
  }));
  app.delete('/api/claude', run((c) => {
    admin(c);
    store.setSecretSetting('claude_oauth_token', null); store.setSecretSetting('anthropic_api_key', null); store.setSetting('claude_token_at', null);
    auth.audit(actorOf(c).label, 'claude_disconnected');
    return c.json({ ok: true });
  }));

  // ---- live updates (SSE). ?task=ID adds that task's events (replayed from ?after=ID / Last-Event-ID).
  app.get('/api/stream', (c) => {
    const taskId = c.req.query('task') ? Number(c.req.query('task')) : null;
    const after = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0);
    return streamSSE(c, async (s) => {
      let lastSent = after;
      const queue: StoreMessage[] = [];
      let wake: (() => void) | null = null;
      const onMsg = (m: StoreMessage) => { queue.push(m); wake?.(); };
      store.bus.on('msg', onMsg);
      s.onAbort(() => { store.bus.off('msg', onMsg); wake?.(); });
      try {
        if (taskId) for (const e of store.listEvents(taskId, after)) { lastSent = e.id; await s.writeSSE({ event: 'event', id: String(e.id), data: JSON.stringify(e) }); }
        await s.writeSSE({ event: 'ready', data: '{}' });
        while (!s.aborted) {
          while (queue.length) {
            const m = queue.shift()!;
            if (m.type === 'event') { if (m.event.taskId === taskId && m.event.id > lastSent) { lastSent = m.event.id; await s.writeSSE({ event: 'event', id: String(m.event.id), data: JSON.stringify(m.event) }); } }
            else await s.writeSSE({ event: m.type, data: JSON.stringify(m.type === 'task' ? view(m.task) : { projectId: m.projectId }) });
          }
          await new Promise<void>((r) => { wake = r; setTimeout(r, 15000); });
          wake = null;
          if (!queue.length && !s.aborted) await s.write(': ping\n\n');
        }
      } finally { store.bus.off('msg', onMsg); }
    });
  });
}
