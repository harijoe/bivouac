import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/db.js';
import { claudeEnv, resolveClaude } from '../src/accounts.js';
import { addTask, makeEnv, makeRemote, repoOf } from './helpers.js';

const OAUTH_A = 'sk-ant-oat01-' + 'A'.repeat(40), OAUTH_B = 'sk-ant-oat01-' + 'B'.repeat(40), KEY = 'sk-ant-api03-' + 'K'.repeat(40);

describe('Claude accounts', () => {
  it('migrates the single token of earlier versions into the account "Default"', () => {
    const key = randomBytes(32), file = path.join(makeEnv().cfg.dataDir, 'old.db');
    const old = new Store(file, key);
    old.db.exec('DELETE FROM claude_accounts');
    old.setSecretSetting('claude_oauth_token', OAUTH_A); old.setSetting('claude_token_at', '2026-01-01T00:00:00.000Z');
    old.db.close();
    const s = new Store(file, key); // reopening runs the migration
    const list = s.listClaudeAccounts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Default', kind: 'oauth', isDefault: true, connectedAt: '2026-01-01T00:00:00.000Z' });
    expect(s.getClaudeSecret(list[0].id)).toBe(OAUTH_A);
    expect(s.getSecretSetting('claude_oauth_token')).toBeNull(); // moved, not copied
    s.db.close();
    expect(new Store(file, key).listClaudeAccounts()).toHaveLength(1); // idempotent
    const raw = new Database(file).prepare('SELECT secret_enc FROM claude_accounts').get() as any;
    expect(raw.secret_enc).not.toContain(OAUTH_A);
  });

  it('an API key that coexisted with a token wins as "Default"', () => {
    const key = randomBytes(32), file = path.join(makeEnv().cfg.dataDir, 'old2.db');
    const old = new Store(file, key);
    old.setSecretSetting('claude_oauth_token', OAUTH_A); old.setSecretSetting('anthropic_api_key', KEY);
    old.db.close();
    const list = new Store(file, key).listClaudeAccounts();
    expect(list.map((a) => [a.name, a.kind, a.isDefault])).toEqual([['Default', 'apikey', true], ['Default (subscription)', 'oauth', false]]);
  });

  it('resolves the project account, else the default, and gives the CLI exactly one credential', () => {
    const env = makeEnv({ oauthToken: null, apiKey: null });
    const a = env.store.createClaudeAccount({ name: 'Perso', kind: 'oauth', secret: OAUTH_A });
    const b = env.store.createClaudeAccount({ name: 'Alpic pro', kind: 'oauth', secret: OAUTH_B });
    const p = env.store.createProject({ name: 'p1', repoUrl: 'x', defaultBranch: 'main' });
    expect(resolveClaude(env.store, env.cfg, p.id)).toMatchObject({ id: a, name: 'Perso' }); // first account = default
    env.store.updateProject(p.id, { claudeAccountId: b });
    expect(resolveClaude(env.store, env.cfg, p.id)).toMatchObject({ id: b, name: 'Alpic pro' });
    expect(claudeEnv(resolveClaude(env.store, env.cfg, p.id))).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_B });
    env.store.deleteClaudeAccount(b); // the project falls back to the default
    expect(resolveClaude(env.store, env.cfg, p.id)?.name).toBe('Perso');
    env.store.createClaudeAccount({ name: 'Key', kind: 'apikey', secret: KEY });
    env.store.updateProject(p.id, { claudeAccountId: env.store.listClaudeAccounts().find((x) => x.name === 'Key')!.id });
    expect(claudeEnv(resolveClaude(env.store, env.cfg, p.id))).toEqual({ ANTHROPIC_API_KEY: KEY });
  });

  it('falls back to the server environment when no account exists', () => {
    const env = makeEnv({ oauthToken: 'sk-ant-oat01-env', apiKey: null });
    expect(resolveClaude(env.store, env.cfg)).toMatchObject({ id: null, name: 'Default', secret: 'sk-ant-oat01-env' });
    expect(makeEnv({ oauthToken: null, apiKey: null }).svc.claudeStatus().connected).toBe(false);
  });

  it('REST: list without secrets, rename, default, delete rules, project account, MCP exposes the name', async () => {
    const env = makeEnv({ oauthToken: null, apiKey: null });
    const created = await env.call('POST', '/api/claude/accounts', { name: 'Perso', key: KEY });
    expect(created.status).toBe(201);
    expect((await env.call('POST', '/api/claude/accounts', { name: 'perso', key: KEY })).status).toBe(409); // names are unique, case-insensitively
    expect((await env.call('POST', '/api/claude/accounts', { name: 'Bad', key: 'nope' })).status).toBe(400);
    const second = await (await env.call('POST', '/api/claude/accounts', { name: 'Pro', key: KEY.replace('K', 'Q') })).json();
    const list = await (await env.call('GET', '/api/claude/accounts')).json();
    expect(list.map((a: any) => [a.name, a.kind, a.isDefault])).toEqual([['Perso', 'apikey', true], ['Pro', 'apikey', false]]);
    expect(JSON.stringify(list)).not.toContain('sk-ant');
    expect((await env.call('PATCH', `/api/claude/accounts/${second.id}`, { name: 'Alpic pro' })).status).toBe(200);
    expect((await env.call('DELETE', `/api/claude/accounts/${list[0].id}`)).status).toBe(409); // the default cannot be deleted while others exist
    const p = addTask(env, makeRemote(), { prompt: 'x' }); const project = env.store.getProject(p.projectId)!;
    expect((await env.call('PATCH', `/api/projects/${project.id}`, { claudeAccountId: second.id })).status).toBe(200);
    expect(env.svc.listProjects()[0].claudeAccountName).toBe('Alpic pro');
    expect((await env.call('PATCH', `/api/projects/${project.id}`, { claudeAccountId: 999 })).status).toBe(404);
    await env.call('PATCH', `/api/claude/accounts/${second.id}`, { isDefault: true });
    expect((await env.call('DELETE', `/api/claude/accounts/${list[0].id}`)).status).toBe(200);
    expect((await env.call('GET', '/api/claude/accounts')).status).toBe(200);
  });

  it('a task uses its project’s account at each session, and names it', async () => {
    const env = makeEnv({ oauthToken: null, apiKey: null });
    env.store.createClaudeAccount({ name: 'Perso', kind: 'oauth', secret: OAUTH_A });
    const b = env.store.createClaudeAccount({ name: 'Pro', kind: 'oauth', secret: OAUTH_B });
    const t = addTask(env, makeRemote(), { prompt: 'x FAKE_SCENARIO=fail-then-succeed', success: 'grep -q ok fake-output.txt' });
    env.store.updateProject(t.projectId, { claudeAccountId: b });
    env.mgr.enqueue(t.id); await env.mgr.settled(t.id);
    const done = env.store.getTask(t.id)!;
    expect(done.status).toBe('succeeded'); expect(done.accountName).toBe('Pro');
    expect(readFileSync(path.join(repoOf(env, t), '.bivouac/fake-auth.log'), 'utf8').trim().split('\n')).toEqual([`oauth:${OAUTH_B}`, `oauth:${OAUTH_B}`]);
  });

  it('creating a task is refused with the account named when its token expired', async () => {
    const env = makeEnv({ oauthToken: null, apiKey: null });
    const id = env.store.createClaudeAccount({ name: 'Perso', kind: 'oauth', secret: OAUTH_A });
    env.store.db.prepare("UPDATE claude_accounts SET connected_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(id);
    env.store.createProject({ name: 'demo', repoUrl: makeRemote(), defaultBranch: 'main' });
    await expect(env.svc.createTask({ project: 'demo', name: 'a', prompt: 'x' }, { kind: 'user', label: 'u' })).rejects.toThrow(/account “Perso” has expired/);
  });
});
