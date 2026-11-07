import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mergeConfig, parseProjectConfig, slugify, type Task } from '@bivouac/shared';
import type { DaemonConfig } from './config.js';
import { safeEqual } from './crypto.js';
import type { Store, StoreMessage } from './db.js';
import { detectDefaultBranch, fetchRepoFile } from './git.js';
import type { TaskManager } from './runner.js';

const VERSION = process.env.BIVOUAC_VERSION ?? 'dev';

export function createApp(cfg: DaemonConfig, store: Store, mgr: TaskManager) {
  const app = new Hono();
  const bad = (c: Context, status: 400 | 404 | 409, message: string, extra: object = {}) => c.json({ error: message, ...extra }, status);

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));
  app.post('/api/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!safeEqual(String(body.token ?? ''), cfg.accessToken)) return c.json({ error: 'invalid token' }, 401);
    setCookie(c, 'bivouac_token', cfg.accessToken, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 365 });
    return c.json({ ok: true });
  });
  app.post('/api/logout', (c) => { setCookie(c, 'bivouac_token', '', { path: '/', maxAge: 0 }); return c.json({ ok: true }); });

  app.use('/api/*', async (c, next) => {
    const h = c.req.header('authorization');
    const given = h?.startsWith('Bearer ') ? h.slice(7) : getCookie(c, 'bivouac_token') ?? '';
    if (!safeEqual(given, cfg.accessToken)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/api/info', (c) => c.json({
    version: VERSION, domain: cfg.domain, previewScheme: cfg.previewScheme, maxParallel: cfg.maxParallel,
    auth: { oauth: !!(store.getSecretSetting('claude_oauth_token') ?? cfg.oauthToken), apiKey: !!(store.getSecretSetting('anthropic_api_key') ?? cfg.apiKey) },
  }));
  app.put('/api/settings', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (b.claudeOauthToken !== undefined) store.setSecretSetting('claude_oauth_token', b.claudeOauthToken || null);
    if (b.anthropicApiKey !== undefined) store.setSecretSetting('anthropic_api_key', b.anthropicApiKey || null);
    return c.json({ ok: true });
  });
  app.get('/api/totals', (c) => c.json(store.totals()));

  // ---- projects
  app.get('/api/projects', (c) => c.json(store.listProjects().map((p) => ({ ...p, totals: store.totals(p.id) }))));
  app.post('/api/projects', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const repoUrl = String(b.repoUrl ?? '').trim();
    if (!repoUrl) return bad(c, 400, 'repoUrl is required');
    const name = slugify(String(b.name ?? path.basename(repoUrl).replace(/\.git$/, '')), 24);
    if (store.getProjectByName(name)) return bad(c, 409, `project "${name}" already exists`);
    const token: string | null = b.githubToken || null;
    let branch: string;
    try { branch = b.defaultBranch || (await detectDefaultBranch(repoUrl, token)); } catch (e: any) { return bad(c, 400, `cannot access repository: ${e.message}`); }
    let config = {};
    if (b.config) { try { config = typeof b.config === 'string' ? parseProjectConfig(b.config) : b.config; } catch (e: any) { return bad(c, 400, e.message); } }
    return c.json(store.createProject({ name, repoUrl, defaultBranch: branch, githubToken: token, config }), 201);
  });
  app.patch('/api/projects/:id', async (c) => {
    const p = store.getProject(Number(c.req.param('id')));
    if (!p) return bad(c, 404, 'no such project');
    const b = await c.req.json().catch(() => ({}));
    let config;
    if (b.config !== undefined) { try { config = typeof b.config === 'string' ? parseProjectConfig(b.config) : b.config; } catch (e: any) { return bad(c, 400, e.message); } }
    store.updateProject(p.id, { config, githubToken: b.githubToken, defaultBranch: b.defaultBranch });
    return c.json(store.getProject(p.id));
  });
  app.delete('/api/projects/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (store.listTasks(id).length) return bad(c, 409, 'delete the project tasks first');
    store.deleteProject(id);
    return c.json({ ok: true });
  });

  // ---- tasks
  app.get('/api/tasks', (c) => {
    const p = c.req.query('project');
    return c.json(store.listTasks(p ? Number(p) : undefined));
  });
  app.post('/api/projects/:id/tasks', async (c) => {
    const p = store.getProject(Number(c.req.param('id')));
    if (!p) return bad(c, 404, 'no such project');
    const b = await c.req.json().catch(() => ({}));
    const prompt = String(b.prompt ?? '').trim();
    if (!prompt) return bad(c, 400, 'prompt is required');
    const baseBranch = String(b.baseBranch || p.defaultBranch);
    let repoCfg = {};
    try {
      const text = await fetchRepoFile(p.repoUrl, baseBranch, 'bivouac.yml', store.getProjectToken(p.id));
      if (text) repoCfg = parseProjectConfig(text);
    } catch (e: any) { return bad(c, 400, e.message); }
    const eff = mergeConfig(repoCfg, p.config);
    const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number(v));
    const maxIterations = num(b.maxIterations, eff.budget?.max_iterations ?? 10);
    const maxCostUsd = num(b.maxCostUsd, eff.budget?.max_cost_usd ?? 20);
    if (![maxIterations, maxCostUsd].every((n) => Number.isFinite(n) && n > 0)) return bad(c, 400, 'budgets must be positive numbers');
    const pub = !!b.publicPreview;
    const previewPass = pub ? Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url') : undefined;
    const task = store.createTask({
      projectId: p.id, title: String(b.title || prompt.split('\n')[0]).slice(0, 80), prompt,
      successCommand: String(b.successCommand || eff.success || 'true'), baseBranch, maxIterations, maxCostUsd,
      maxTokens: b.maxTokens ? Number(b.maxTokens) : eff.budget?.max_tokens ?? null, publicPreview: pub, previewUser: pub ? 'preview' : undefined, previewPass,
    }, (id) => `agent/t-${id}-${slugify(String(b.title || prompt), 30)}`);
    mgr.enqueue(task.id);
    return c.json({ ...store.getTask(task.id), ...(previewPass ? { previewAuth: { user: 'preview', password: previewPass } } : {}) }, 201);
  });
  const withTask = (fn: (c: Context, t: Task) => Promise<Response> | Response) => async (c: Context) => {
    const t = store.getTask(Number(c.req.param('id')));
    if (!t) return bad(c, 404, 'no such task');
    try { return await fn(c, t); } catch (e: any) {
      if (e.code === 'UNPUSHED') return bad(c, 409, e.message, { code: 'UNPUSHED', unpushed: e.unpushed });
      return bad(c, 400, String(e.message ?? e));
    }
  };
  app.get('/api/tasks/:id', withTask((c, t) => c.json({ ...t, pendingInstructions: store.pendingInstructionCount(t.id), active: mgr.isActive(t.id) })));
  app.get('/api/tasks/:id/events', withTask((c, t) => c.json(store.listEvents(t.id, Number(c.req.query('after') ?? 0)))));
  app.get('/api/tasks/:id/devlogs', withTask(async (c, t) => c.json({ text: await mgr.devLogs(t.id, Number(c.req.query('lines') ?? 200)) })));
  app.post('/api/tasks/:id/stop', withTask(async (c, t) => { await mgr.stop(t.id); return c.json(store.getTask(t.id)); }));
  app.post('/api/tasks/:id/resume', withTask(async (c, t) => { const b = await c.req.json().catch(() => ({})); await mgr.resume(t.id, b.text); return c.json(store.getTask(t.id)); }));
  app.post('/api/tasks/:id/instruct', withTask(async (c, t) => {
    const b = await c.req.json().catch(() => ({}));
    const text = String(b.text ?? '').trim();
    if (!text) return bad(c, 400, 'text is required');
    return c.json(await mgr.instruct(t.id, text));
  }));
  app.patch('/api/tasks/:id', withTask(async (c, t) => {
    const b = await c.req.json().catch(() => ({}));
    store.patchTask(t.id, { maxCostUsd: b.maxCostUsd, maxIterations: b.maxIterations, maxTokens: b.maxTokens });
    return c.json(store.getTask(t.id));
  }));
  app.post('/api/tasks/:id/push', withTask(async (c, t) => { await mgr.push(t.id); return c.json(store.getTask(t.id)); }));
  app.post('/api/tasks/:id/pr', withTask(async (c, t) => { const url = await mgr.openPr(t.id); return c.json({ url }); }));
  app.delete('/api/tasks/:id', withTask(async (c, t) => { await mgr.destroy(t.id, c.req.query('force') === '1'); return c.json({ ok: true }); }));

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
            else await s.writeSSE({ event: m.type, data: JSON.stringify(m.type === 'task' ? m.task : { projectId: m.projectId }) });
          }
          await new Promise<void>((r) => { wake = r; setTimeout(r, 15000); });
          wake = null;
          if (!queue.length && !s.aborted) await s.write(': ping\n\n');
        }
      } finally { store.bus.off('msg', onMsg); }
    });
  });

  // ---- dashboard (static, SPA fallback)
  const dir = cfg.dashboardDir;
  if (dir && existsSync(dir)) {
    app.use('/*', serveStatic({ root: path.relative(process.cwd(), dir) || '.' }));
    app.get('*', (c) => c.html(readFileSync(path.join(dir, 'index.html'), 'utf8')));
  }
  return app;
}
