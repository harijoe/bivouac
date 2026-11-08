// Checks of the v0.3 e2e, run from OUTSIDE the server. One command per call, state kept in a JSON file between calls.
//   node scripts/e2e-v03-client.mjs <command> --base https://… --session <cookie> --state <file> [--insecure] [...]
// Commands: seed, verify-seed, update-check, update-run, update-expect, long-task, multi, grow, context, banner
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [cmd, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]] : a), []));
const BASE = String(args.base).replace(/\/$/, ''), HOST = new URL(BASE).host;
const COOKIE = `__Host-bv_session=${args.session}`;
if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const STATE = args.state;
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state));
const require = createRequire(path.resolve('packages/daemon/package.json'));
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const { auth } = await import(require.resolve('@modelcontextprotocol/sdk/client/auth.js'));

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); process.exit(1); };
const check = (c, m) => (c ? ok(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 180000, every = 2000, what = 'condition') {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const r = await fn(); if (r) return r; } catch (e) { last = e; } await sleep(every); }
  fail(`timeout waiting for ${what} (${last ?? ''})`);
}
const raw = (url, o = {}) => fetch(url, { redirect: 'manual', ...o });
const dash = async (method, p, body) => {
  const r = await raw(BASE + p, { method, headers: { cookie: COOKIE, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};

// ---- MCP through the official SDK; OAuth tokens live in the state file so they survive updates
const provider = {
  get redirectUrl() { return 'http://localhost:33418/callback'; },
  get clientMetadata() { return { client_name: 'e2e-v03', redirect_uris: ['http://localhost:33418/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
  clientInformation: () => state.client, saveClientInformation: (c) => { state.client = c; save(); },
  tokens: () => state.tokens, saveTokens: (t) => { state.tokens = t; save(); },
  saveCodeVerifier: (v) => { state.verifier = v; save(); }, codeVerifier: () => state.verifier,
  redirectToAuthorization: async (url) => { state.authUrl = String(url); save(); },
};
const mcpUrl = new URL(`${BASE}/mcp`);
async function authorize() {
  let res = await auth(provider, { serverUrl: mcpUrl });
  if (res === 'AUTHORIZED') return;
  const au = new URL(state.authUrl);
  const approved = await dash('POST', '/api/oauth/authorize', { ...Object.fromEntries(au.searchParams), decision: 'approve' });
  res = await auth(provider, { serverUrl: mcpUrl, authorizationCode: new URL(approved.json.redirect).searchParams.get('code') });
  check(res === 'AUTHORIZED', 'MCP client authorized (OAuth, PKCE)');
}
async function mcp() {
  const mc = new Client({ name: 'e2e-v03', version: '1' });
  await mc.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  const call = async (name, a) => mc.callTool({ name, arguments: a });
  return { mc, call };
}
const toolJson = (r) => JSON.parse(r.content[0].text);
const toolText = (r) => r.content[0].text;

async function connectClaude() {
  const login = (await dash('POST', '/api/claude/login')).json;
  await waitFor(async () => (await dash('GET', `/api/claude/login/${login.id}`)).json.phase === 'waiting_code', 60000, 1500, 'sign-in URL');
  await dash('POST', `/api/claude/login/${login.id}/code`, { code: 'FAKE-CODE' });
  await waitFor(async () => (await dash('GET', `/api/claude/login/${login.id}`)).json.phase === 'done', 60000, 1500, 'token');
}
const finalStatuses = ['succeeded', 'failed', 'budget_exceeded', 'max_iterations', 'stopped'];
async function waitTask(call, project, name, ms = 420000) {
  let t;
  await waitFor(async () => { t = toolJson(await call('get_task', { project, task: name })); return finalStatuses.includes(t.status); }, ms, 4000, `task ${name}`);
  return t;
}

/** Opens a preview URL the way a browser does: the owner ticket becomes a cookie, then the page is fetched with it. */
async function fetchPreview(taskId, portName) {
  const link = (await dash('POST', `/api/tasks/${taskId}/preview-link`, portName ? { port: portName } : {})).json.url;
  let r = await raw(link);
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (r.status >= 300 && r.status < 400) r = await raw(new URL(r.headers.get('location'), link).href, { headers: { cookie } });
  return { status: r.status, body: await r.text(), link };
}

const commands = {
  async seed() {
    await authorize();
    await connectClaude();
    const added = await dash('POST', '/api/projects', { repoUrl: args['repo-url'], githubToken: process.env.GH_TOKEN, name: 'legacy', defaultBranch: 'example-legacy' });
    check(added.status === 201, 'project legacy added');
    await dash('PUT', '/api/settings/budgets', { maxIterations: 7, maxCostUsd: 3 });
    const { call } = await mcp();
    const t = toolJson(await call('create_task', { project: 'legacy', name: 'old-task', prompt: 'build it', success_command: 'true', max_iterations: 3, max_cost_usd: 2 }));
    check(t.started, 'a task was created with the previous version');
    const done = await waitTask(call, 'legacy', 'old-task');
    check(done.status === 'succeeded', 'the task succeeded');
    await dash('POST', `/api/tasks/${done.id}/shares`, { duration: '7d' });
    state.seed = { taskId: done.id, branch: done.branch, cost: done.costUsd, shares: 1 };
    save();
  },

  async 'verify-seed'() {
    const { call } = await mcp();   // same OAuth tokens as before the update
    check(toolJson(await call('list_projects', {})).some((p) => p.name === 'legacy'), 'projects intact, and the MCP client still works');
    const t = toolJson(await call('get_task', { project: 'legacy', task: 'old-task' }));
    check(t.status === 'succeeded' && t.id === state.seed.taskId && t.branch === state.seed.branch && Math.abs(t.costUsd - state.seed.cost) < 1e-9, 'the old task is intact (status, branch, cost)');
    check(t.shareLinks.length === state.seed.shares, 'share links intact');
    const s = (await dash('GET', '/api/settings')).json;
    check(s.claude.connected && s.budgets.maxIterations === 7 && s.budgets.maxCostUsd === 3, 'settings intact (Claude connection, default limits)');
    check(s.grants.some((g) => g.clientName === 'e2e-v03'), 'the MCP client is still registered');
    const events = (await dash('GET', `/api/tasks/${t.id}/events`)).json;
    check(events.length > 3, `event history intact (${events.length} events)`);
    if (args.expect) check(s.version === args.expect, `installed version is ${args.expect}`);
  },

  async 'update-check'() {
    const before = (await dash('GET', '/api/update')).json;
    const after = (await dash('POST', '/api/update/check')).json;
    check(after.current === args.current, `current version ${after.current}`);
    check(after.available?.version === args.expect, `banner: version ${args.expect} is available (checked ${after.checkedAt})`);
    check(/notes for/.test(after.available.notes), 'release notes are delivered');
    void before;
  },

  async 'update-run'() {
    const mode = args.mode ?? 'idle';
    const r = await dash('POST', '/api/update/start', { mode });
    check(r.status === 200, `update started (${mode}) → ${JSON.stringify(r.json)}`);
    if (args.expect === 'scheduled') { check(r.json.scheduled === true && r.json.started === false, 'the update is scheduled until no task runs'); return; }
    check(r.json.started === true, 'update running');
    const steps = new Set();
    const end = await waitFor(async () => {
      try {
        const u = (await dash('GET', '/api/update')).json;
        if (u.progress) steps.add(u.progress.step);
        return u.progress && u.progress.to === args.to && ['done', 'rolled_back', 'failed'].includes(u.progress.state) ? u : false;
      } catch { return false; }  // the web service restarts during the update
    }, 420000, 2000, 'the update to finish');
    console.log(`  steps seen from the dashboard: ${[...steps].join(' → ')}`);
    if (args.result === 'rolled_back') {
      check(end.progress.state === 'rolled_back', 'the broken version was rolled back automatically');
      check(end.current === args.from, `the previous version ${args.from} is running again`);
      check(/did not become healthy/.test(end.progress.error ?? '') && end.progress.error.includes(args.from), `the dashboard says why: "${end.progress.error}"`);
    } else {
      check(end.progress.state === 'done' && end.current === args.to, `updated to ${end.current}`);
    }
  },

  async 'update-wait-scheduled'() {
    // the update starts by itself when the last task ends
    const end = await waitFor(async () => { const u = (await dash('GET', '/api/update')).json; return u.current === args.to && u.progress?.state === 'done' ? u : false; }, 420000, 3000, 'the scheduled update');
    check(!end.scheduled, `scheduled update ran by itself, now on ${end.current}`);
  },

  async 'long-task'() {
    const { call } = await mcp();
    const t = toolJson(await call('create_task', { project: 'legacy', name: args.name, prompt: `slow job FAKE_DELAY=${args.delay ?? 12000}`, success_command: 'true', max_iterations: 2, max_cost_usd: 2 }));
    check(t.started, `long task ${args.name} started`);
    await waitFor(async () => toolJson(await call('get_task', { project: 'legacy', task: args.name })).status === 'running', 120000, 2000, 'the task to run');
    state.longTask = args.name; save();
  },

  async 'blocked-create'() {
    const { call } = await mcp();
    const r = await call('create_task', { project: 'legacy', name: 'blocked-one', prompt: 'x' });
    check(r.isError && /waiting for the running tasks[\s\S]*retry in a few minutes/.test(toolText(r)), `new tasks are refused with a clear message: "${toolText(r).slice(0, 110)}…"`);
  },

  async 'task-state'() {
    const { call } = await mcp();
    const t = toolJson(await call('get_task', { project: 'legacy', task: args.name }));
    check(t.status === args.expect, `task ${args.name} is ${t.status}`);
    if (args.resume) { const r = toolJson(await call('resume_task', { project: 'legacy', task: args.name })); check(['queued', 'starting', 'running'].includes(r.status), 'a stopped task can be resumed after the update'); await waitTask(call, 'legacy', args.name); }
  },

  async audit() {
    const rows = (await dash('GET', '/api/settings/audit?limit=100')).json;
    for (const a of args.actions.split(',')) check(rows.some((r) => r.action === a), `audit log has "${a}"${rows.find((r) => r.action === a) ? ` by ${rows.find((r) => r.action === a).actor}` : ''}`);
  },

  async multi() {
    const added = await dash('POST', '/api/projects', { repoUrl: args['repo-url'], githubToken: process.env.GH_TOKEN, name: 'multi', defaultBranch: 'example-multi' });
    check(added.status === 201 || added.status === 409, 'project multi added');
    const { call } = await mcp();
    const tasks = {};
    for (const n of ['alpha', 'beta']) {
      tasks[n] = toolJson(await call('create_task', { project: 'multi', name: n, prompt: `task ${n}`, max_iterations: 3, max_cost_usd: 2 }));
      check(tasks[n].urls.length === 0 || tasks[n].started, `task ${n} started (two tasks in parallel)`);
    }
    for (const n of ['alpha', 'beta']) {
      const t = await waitTask(call, 'multi', n);
      check(t.status === 'succeeded', `${n} succeeded (its success command reached postgres:5432 by name)`);
      check(t.urls.length === 2 && t.urls[0].main && t.urls[1].name === 'api', `${n} lists both URLs: ${t.urls.map((u) => u.url).join(' , ')}`);
      check(t.urls[0].url === `https://${n}.multi.${HOST}` && t.urls[1].url === `https://api.${n}.multi.${HOST}`, 'URL shape: <task>.<project>.<domain> and api.<task>.<project>.<domain>');
      check(t.services.length === 1 && t.services[0].name === 'postgres', 'get_task lists the postgres service');
      tasks[n] = t;
    }
    for (const n of ['alpha', 'beta']) {
      const web = await fetchPreview(tasks[n].id);
      check(web.status === 200 && web.body.includes(`web of task ${tasks[n].id}`), `${n}: the front answers (${web.body.trim().slice(0, 40)})`);
      const api = await fetchPreview(tasks[n].id, 'api');
      check(api.status === 200 && JSON.parse(api.body).task === String(tasks[n].id) && JSON.parse(api.body).postgres === 'up', `${n}: the API answers and sees its own postgres (${api.body.trim()})`);
      const anon = await raw(`https://api.${n}.multi.${HOST}/`);
      check(anon.status === 401 || anon.status === 403, `${n}: the API URL is protected without a ticket (${anon.status})`);
    }
    // a share link opens every port of the task
    const share = (await dash('POST', `/api/tasks/${tasks.alpha.id}/shares`, { duration: '1h' })).json;
    check(share.urls?.length === 2, 'one share link covers both ports');
    for (const u of share.urls) {
      let r = await raw(u.url);
      const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      if (r.status >= 300 && r.status < 400) r = await raw(new URL(r.headers.get('location'), u.url).href, { headers: { cookie } });
      check(r.status === 200, `share link works on "${u.name}"`);
    }
    state.multi = { alpha: tasks.alpha.id, beta: tasks.beta.id }; save();
  },

  async grow() {
    const added = await dash('POST', '/api/projects', { repoUrl: args['repo-url'], githubToken: process.env.GH_TOKEN, name: 'grow', defaultBranch: 'example-multi-min' });
    check(added.status === 201 || added.status === 409, 'project grow added (front only)');
    const { call } = await mcp();
    // the first check edits bivouac.yml (adds the api port and a redis) and fails: the next agent session must pick the change up
    const yml = 'dev:\\n  command: node server.mjs\\nports:\\n  web: 5173\\n  api: 3000\\nservices:\\n  redis:\\n    image: redis:7-alpine\\n    memory: 128m\\nsuccess: "true"\\n';
    const success = `[ -f .grown ] || { touch .grown; printf '${yml}' > bivouac.yml; exit 3; }; true`;
    const t = toolJson(await call('create_task', { project: 'grow', name: 'grower', prompt: 'grow FAKE_SCENARIO=fail-then-succeed', success_command: success, max_iterations: 4, max_cost_usd: 2 }));
    check(t.started && t.urls.length <= 1, 'task grower started with the front only');
    const done = await waitTask(call, 'grow', 'grower');
    check(done.status === 'succeeded' && done.iteration === 2, `grower succeeded at its second attempt`);
    check(done.urls.map((u) => u.name).join() === 'web,api', `the port added by the agent got its URL: ${done.urls.map((u) => u.url).join(' , ')}`);
    check(done.services.map((s) => s.name).join() === 'redis', 'the service added by the agent is declared');
    const api = await fetchPreview(done.id, 'api');
    check(api.status === 200 && JSON.parse(api.body).api === true, 'the new API URL answers through Traefik, live');
    state.grow = done.id; save();
  },

  async context() {
    const { call, mc } = await mcp();
    const tools = (await mc.listTools()).tools.map((t) => t.name);
    check(tools.includes('get_project_context') && tools.includes('read_project_file'), 'the context tools are listed');
    const prompts = (await mc.listPrompts()).prompts.map((p) => p.name);
    check(prompts.includes('plan_next_mission'), 'the planning prompt is listed');
    const r = await call('get_project_context', { project: 'multi' });
    const text = toolText(r);
    check(!r.isError, `get_project_context answered (${text.length} characters, about ${Math.round(text.length / 4)} tokens)`);
    check(text.length < 60000, 'the snapshot stays compact');
    check(/# Project multi/.test(text) && /example-multi/.test(text), 'it describes the project and its branch');
    check(/alpha — succeeded/.test(text) && /beta — succeeded/.test(text), 'it describes the two finished tasks');
    check(/task alpha/.test(text) && /node check\.mjs/.test(text), 'it includes their prompts and the success command result');
    check(/postgres/.test(text) && /server\.mjs/.test(text), 'it includes the effective bivouac.yml and the code structure');
    check(!/BEGIN [A-Z ]*PRIVATE KEY|ghp_|github_pat_|sk-ant-/.test(text), 'no secret in the snapshot');
    const f = await call('read_project_file', { project: 'multi', path: 'server.mjs' });
    check(!f.isError && /createServer/.test(toolText(f)), 'read_project_file reads a file');
    const bad = await call('read_project_file', { project: 'multi', path: '../../etc/passwd' });
    check(bad.isError, 'read_project_file refuses a path outside the repository');
    const p = await mc.getPrompt({ name: 'plan_next_mission', arguments: { project: 'multi' } });
    check(/get_project_context/.test(p.messages[0].content.text), 'the planning prompt calls the context tool');
  },

  async cleanup() {
    const { call } = await mcp();
    for (const [p, n] of [['multi', 'alpha'], ['multi', 'beta'], ['grow', 'grower']]) {
      const t = toolJson(await call('get_task', { project: p, task: n }));
      const r = await dash('DELETE', `/api/tasks/${t.id}?force=1`);
      check(r.status === 200, `task ${n} deleted`);
    }
  },
};

if (!commands[cmd]) { console.error(`unknown command ${cmd}`); process.exit(2); }
console.log(`\n== ${cmd}`);
await commands[cmd]();
process.exit(0); // the MCP transport keeps the event loop alive
