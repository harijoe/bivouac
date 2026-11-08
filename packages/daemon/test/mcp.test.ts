import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { addProject, makeEnv, makeRemote } from './helpers.js';

export async function connect(env: ReturnType<typeof makeEnv>) {
  const g = env.ctx.oauth.registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const code = env.ctx.oauth.issueCode({ clientId: g.clientId, githubId: 42, redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'x'.repeat(43) });
  // exchange the code directly through the DB-level API (PKCE is covered in oauth.test.ts)
  env.store.db.prepare('UPDATE oauth_codes SET code_challenge = ?').run(require_s256('v'.repeat(50)));
  const tokens = env.ctx.oauth.exchangeCode({ code, client_id: g.clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'v'.repeat(50) }).tokens;
  const transport = new StreamableHTTPClientTransport(new URL('https://1-2-3-4.sslip.io/mcp'), {
    fetch: (async (u: any, init: any) => env.app.request(String(u).replace('https://1-2-3-4.sslip.io', ''), init)) as typeof fetch,
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
}
import { createHash } from 'node:crypto';
const require_s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

const text = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(text(r));

describe('MCP server', () => {
  it('lists the tools with correct annotations and model-oriented descriptions', async () => {
    const env = makeEnv();
    const c = await connect(env);
    const { tools } = await c.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(['create_share_link', 'create_task', 'get_project_context', 'get_task', 'list_projects', 'list_tasks', 'open_pr', 'push_branch', 'read_project_file', 'resume_task', 'revoke_share_link', 'send_instruction', 'stop_task']);
    for (const ro of ['list_projects', 'list_tasks', 'get_task', 'get_project_context', 'read_project_file']) expect(by[ro].annotations?.readOnlyHint).toBe(true);
    for (const rw of ['create_task', 'send_instruction', 'stop_task', 'resume_task', 'create_share_link', 'revoke_share_link', 'push_branch', 'open_pr']) expect(by[rw].annotations?.readOnlyHint).toBe(false);
    expect(by.stop_task.annotations?.destructiveHint).toBe(true);
    expect(by.create_task.description).toMatch(/returns immediately/i);
    expect(by.create_task.inputSchema.required).toEqual(expect.arrayContaining(['project', 'name', 'prompt']));
    await c.close();
  });

  it('creates tasks, polls them to success, shares a preview, stops another', async () => {
    const env = makeEnv();
    const remote = makeRemote({ 'README.md': 'x', 'bivouac.yml': 'success: grep -q ok fake-output.txt\ndev:\n  command: sleep 1000\n  port: 3001\n' });
    addProject(env, remote);
    const c = await connect(env);
    expect(json(await c.callTool({ name: 'list_projects', arguments: {} }))[0]).toMatchObject({ name: 'demo', defaultBranch: 'main', tasks: 0 });

    const a = json(await c.callTool({ name: 'create_task', arguments: { project: 'demo', name: 'login-page', prompt: 'build it', idempotency_key: 'k1' } }));
    expect(a).toMatchObject({ name: 'login-page', project: 'demo', started: true });
    expect(a.previewUrl).toBe('https://login-page.demo.1-2-3-4.sslip.io');
    expect(a.dashboardUrl).toBe('https://1-2-3-4.sslip.io/projects/demo/login-page');
    // retry with the same key: same task, no duplicate
    const again = json(await c.callTool({ name: 'create_task', arguments: { project: 'demo', name: 'login-page', prompt: 'build it', idempotency_key: 'k1' } }));
    expect(again.id).toBe(a.id); expect(again.started).toBe(false);

    const b = json(await c.callTool({ name: 'create_task', arguments: { project: 'demo', name: 'slow-one', prompt: 'x FAKE_DELAY=400 FAKE_SCENARIO=always-fail', success_command: 'false' } }));
    expect(b.id).not.toBe(a.id);

    let t: any;
    for (let i = 0; i < 100; i++) {
      t = json(await c.callTool({ name: 'get_task', arguments: { project: 'demo', task: 'login-page' } }));
      if (t.status === 'succeeded') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(t.status).toBe('succeeded');
    expect(t.lastMessages.length).toBeGreaterThan(0);
    expect(t.lastCheck).toMatchObject({ exitCode: 0 });
    expect(t.costUsd).toBeGreaterThan(0);

    const share = json(await c.callTool({ name: 'create_share_link', arguments: { project: 'demo', task: 'login-page', duration: '1h' } }));
    expect(share.url).toMatch(/^https:\/\/login-page\.demo\.1-2-3-4\.sslip\.io\/\?bv_share=/);
    expect(json(await c.callTool({ name: 'get_task', arguments: { project: 'demo', task: 'login-page' } })).shareLinks).toHaveLength(1);
    await c.callTool({ name: 'revoke_share_link', arguments: { project: 'demo', task: 'login-page', link_id: share.id } });
    expect(json(await c.callTool({ name: 'get_task', arguments: { project: 'demo', task: 'login-page' } })).shareLinks).toHaveLength(0);

    const stopped = json(await c.callTool({ name: 'stop_task', arguments: { project: 'demo', task: 'slow-one' } }));
    expect(stopped.status).toBe('stopped');
    expect(json(await c.callTool({ name: 'list_tasks', arguments: { status: 'stopped' } }))).toHaveLength(1);
    // audit trail
    const audit = env.ctx.auth.listAudit().map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['task_created', 'task_stopped', 'share_created', 'share_revoked']));
    expect(env.ctx.auth.listAudit().find((a) => a.action === 'task_created')!.actor).toBe('mcp:Claude:julien');
    await c.close();
  });

  it('errors tell the model what to do', async () => {
    const env = makeEnv();
    addProject(env, makeRemote());
    const c = await connect(env);
    const err = async (args: Record<string, unknown>, name = 'create_task') => { const r: any = await c.callTool({ name, arguments: args }); expect(r.isError).toBe(true); return text(r); };
    expect(await err({ project: 'nope', name: 'x', prompt: 'p' })).toMatch(/Unknown project "nope"\. Known projects: demo/);
    expect(await err({ project: 'demo', name: 'Bad Name!', prompt: 'p' })).toMatch(/lowercase letters, digits and dashes/);
    expect(await err({ project: 'demo', name: 'a'.repeat(41), prompt: 'p' })).toMatch(/not a valid task name/);
    await c.callTool({ name: 'create_task', arguments: { project: 'demo', name: 'same', prompt: 'p' } });
    expect(await err({ project: 'demo', name: 'same', prompt: 'p' })).toMatch(/already used in project "demo"\. Propose another name/);
    expect(await err({ project: 'demo', task: 'ghost' }, 'get_task')).toMatch(/Unknown task "ghost".*list_tasks/);
    // Claude not connected: actionable message with the dashboard link
    env.cfg.oauthToken = null;
    expect(await err({ project: 'demo', name: 'other', prompt: 'p' })).toMatch(/Claude is not connected.*https:\/\/1-2-3-4\.sslip\.io\/settings/);
    // expired token
    env.store.setSecretSetting('claude_oauth_token', 'sk-ant-oat01-x'.padEnd(40, 'x'));
    env.store.setSetting('claude_token_at', new Date(Date.now() - 400 * 86400_000).toISOString());
    expect(await err({ project: 'demo', name: 'other', prompt: 'p' })).toMatch(/token has expired.*reconnect Claude/);
    // PR on a project without GitHub
    expect(await err({ project: 'demo', task: 'same' }, 'open_pr')).toMatch(/not connected to GitHub/);
    await c.close();
  });

  it('rejects calls without a valid token or for a removed user', async () => {
    const env = makeEnv();
    const c = await connect(env);
    await c.listTools();
    env.ctx.auth.upsertUser({ githubId: 42, login: 'julien' }, 'user'); // no longer admin and not allow-listed
    const t = new StreamableHTTPClientTransport(new URL('https://x/mcp'), { fetch: (async (u: any, init: any) => env.app.request('/mcp', init)) as typeof fetch, requestInit: { headers: { Authorization: 'Bearer bvat_nope' } } });
    await expect(new Client({ name: 't', version: '1' }).connect(t)).rejects.toThrow();
    await expect(c.listTools()).rejects.toThrow();
  });
});
