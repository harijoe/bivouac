import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitignoreMatcher, isSecretPath, redactSecrets, summarizeTree, truncateSmart, SNAPSHOT_CHARS } from '../src/projectcontext.js';
import { connect } from './mcp-client.js';
import { addProject, makeEnv, makeRemote } from './helpers.js';

const GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const FILES = {
  'README.md': `# Demo app\n\nA small app. ${GHP}\n`,
  'CLAUDE.md': 'Use pnpm. Keep it small.\n',
  'PROGRESS.md': '## Done\n- login\n' + 'x'.repeat(20000) + '\n## Next\n- billing\n',
  '.env': 'DATABASE_URL=postgres://user:SuperSecretPassw0rd@db/app\n',
  '.env.example': 'DATABASE_URL=\n',
  '.gitignore': 'secret-notes.txt\nbuild/\n',
  'secret-notes.txt': 'do not show me\n',
  'src/index.ts': 'export const x = 1;\n',
  'src/deep/a.ts': 'export const a = 2;\n',
  'bivouac.yml': 'success: "true"\ndev:\n  command: sleep 1000\n  port: 3001\nservices:\n  db:\n    image: postgres:16\n    env: { POSTGRES_PASSWORD: hunter2 }\n',
  'keys/server.pem': '-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----\n',
};
function remoteWithFiles() {
  const dir = makeRemote({ 'README.md': 'x' });
  for (const [f, c] of Object.entries(FILES)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); }
  execSync('git add -A -f && git -c user.name=t -c user.email=t@t commit -qm "second commit: add app"', { cwd: dir });
  return dir;
}

describe('helpers', () => {
  it('detects secret files but keeps examples', () => {
    for (const p of ['.env', 'apps/web/.env.local', 'keys/server.pem', 'id_rsa', '.npmrc', 'config/credentials.json', '.aws/credentials']) expect(isSecretPath(p), p).toBe(true);
    for (const p of ['.env.example', 'src/env.ts', 'README.md', 'src/secrets-manager.ts']) expect(isSecretPath(p), p).toBe(false);
  });
  it('redacts tokens and key=value secrets', () => {
    const r = redactSecrets(`token ${GHP} and sk-ant-oat01-abcdefghijklmnop1234 and PASSWORD="hunter2hunter2hunter" and Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- ok`);
    expect(r).not.toMatch(/ghp_|sk-ant|hunter2|abcdefghijklmnopqrst|MIIE/);
    expect(r).toContain('PASSWORD=[redacted]');
    expect(redactSecrets('secret = process.env.SECRET_KEY')).toContain('process.env.SECRET_KEY');
  });
  it('matches gitignore rules', () => {
    const m = gitignoreMatcher('node_modules/\n*.log\n/dist\nsecret.txt\n!keep.log\n');
    expect(m('node_modules/a/b.js')).toBe(true);
    expect(m('x/y/z.log')).toBe(true);
    expect(m('keep.log')).toBe(false);
    expect(m('dist/a.js')).toBe(true);
    expect(m('src/dist/a.js')).toBe(false);
    expect(m('deep/secret.txt')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });
  it('truncates keeping the start and the end', () => {
    const t = truncateSmart('A'.repeat(1000) + 'MIDDLE' + 'Z'.repeat(1000), 200);
    expect(t.length).toBeLessThan(330);
    expect(t.startsWith('AAA')).toBe(true); expect(t.endsWith('ZZZ')).toBe(true); expect(t).toMatch(/characters omitted/);
    expect(truncateSmart('short', 200)).toBe('short');
  });
  it('summarizes the tree without node_modules and with languages', () => {
    const s = summarizeTree([{ path: 'src/a.ts', size: 3000 }, { path: 'src/b.ts', size: 1000 }, { path: 'node_modules/x/y.js', size: 9e6 }, { path: 'README.md', size: 100 }]);
    expect(s).toMatch(/3 files/); expect(s).toMatch(/TypeScript 100%/); expect(s).not.toMatch(/node_modules/);
  });
});

describe('project snapshot', () => {
  it('reports the latest message of a task with a very long history', async () => {
    const env = makeEnv(); const p = addProject(env, remoteWithFiles());
    const t = env.store.createTask({ projectId: p.id, name: 'long', title: 't', prompt: 'x', successCommand: 'true', baseBranch: 'main', maxIterations: 5, maxCostUsd: 10, maxTokens: null }, (id) => `agent/t-${id}-long`);
    for (let i = 0; i < 5100; i++) env.store.addEvent(t.id, 'assistant_text', { text: `msg ${i}` });
    expect(await env.svc.pctx.snapshot(p, 'task:long')).toContain("agent's last message: msg 5099");
  });
  it('describes the project, the tasks and the problems, without secrets, within the budget', async () => {
    const env = makeEnv(); const remote = remoteWithFiles();
    const p = addProject(env, remote);
    const t1 = env.store.createTask({ projectId: p.id, name: 'login-page', title: 't', prompt: 'Build the login page', successCommand: 'pnpm test', baseBranch: 'main', maxIterations: 5, maxCostUsd: 10, maxTokens: null }, (id) => `agent/t-${id}-login-page`);
    env.store.addEvent(t1.id, 'tool_use', { name: 'Edit', input: { file_path: '/workspace/repo/src/login.ts' } });
    env.store.addEvent(t1.id, 'assistant_text', { text: 'I added the login page and its tests.' });
    env.store.addEvent(t1.id, 'check', { command: 'pnpm test', exitCode: 0, output: 'ok' });
    env.store.setStatus(t1.id, 'succeeded');
    const t2 = env.store.createTask({ projectId: p.id, name: 'billing', title: 't', prompt: 'Add billing', successCommand: 'pnpm test', baseBranch: 'main', maxIterations: 5, maxCostUsd: 10, maxTokens: null }, (id) => `agent/t-${id}-billing`);
    env.store.addEvent(t2.id, 'check', { command: 'pnpm test', exitCode: 1, output: `1 failing\nAPI_KEY=${GHP}` });
    env.store.setStatus(t2.id, 'max_iterations');
    const t3 = env.store.createTask({ projectId: p.id, name: 'expensive', title: 't', prompt: 'Rewrite all', successCommand: 'true', baseBranch: 'main', maxIterations: 5, maxCostUsd: 1, maxTokens: null }, (id) => `agent/t-${id}-expensive`);
    env.store.setStatus(t3.id, 'budget_exceeded');

    const out = await env.svc.pctx.snapshot(p);
    expect(out).toContain('# Project demo');
    expect(out).toMatch(/last commit: [0-9a-f]+ second commit: add app/);
    expect(out).toContain('Use pnpm');                       // CLAUDE.md
    expect(out).toContain('Demo app');                       // README
    expect(out).toMatch(/omitted/);                          // PROGRESS.md is long: truncated, not dropped
    expect(out).toContain('billing');                        // end of PROGRESS survives truncation
    expect(out).toContain('src/');                           // structure
    expect(out).toMatch(/TypeScript/);
    expect(out).toContain('login-page — succeeded');
    expect(out).toContain('I added the login page');
    expect(out).toContain('src/login.ts');
    expect(out).toMatch(/billing — max_iterations/);
    expect(out).toMatch(/Known problems[\s\S]*expensive[^\n]*budget[\s\S]*billing[^\n]*verification failing/);
    expect(out).toContain('"dev"');                          // effective config
    // no secret, no ignored or secret file, no file contents
    for (const bad of [GHP, 'SuperSecretPassw0rd', 'do not show me', 'BEGIN PRIVATE KEY', 'hunter2', 'export const x = 1', 'secret-notes.txt', 'server.pem']) expect(out, bad).not.toContain(bad);
    expect(out.length).toBeLessThan(SNAPSHOT_CHARS * 1.3);
  });

  it('detail: one task in full, one document, the tree, the commits; bad detail is explained', async () => {
    const env = makeEnv(); const p = addProject(env, remoteWithFiles());
    const t = env.store.createTask({ projectId: p.id, name: 'billing', title: 't', prompt: 'Add billing. ' + 'long '.repeat(300), successCommand: 'true', baseBranch: 'main', maxIterations: 5, maxCostUsd: 10, maxTokens: null }, (id) => `agent/t-${id}`);
    expect(await env.svc.pctx.snapshot(p, 'task:billing')).toContain('long long long long long long long long long long long long long long long long long long long long long long long long long long long long');
    expect(await env.svc.pctx.snapshot(p, 'doc:CLAUDE.md')).toContain('Use pnpm');
    expect(await env.svc.pctx.snapshot(p, 'tree')).toContain('src/deep/');
    expect(await env.svc.pctx.snapshot(p, 'commits')).toContain('second commit');
    await expect(env.svc.pctx.snapshot(p, 'task:nope')).rejects.toThrow(/No task "nope"/);
    await expect(env.svc.pctx.snapshot(p, 'bogus')).rejects.toThrow(/Unknown detail/);
    await expect(env.svc.pctx.snapshot(p, 'doc:.env')).rejects.toThrow(/secret/);
    void t;
  });

  it('read_project_file: reads, refuses secrets, ignored files, traversal and unknown refs', async () => {
    const env = makeEnv(); const p = addProject(env, remoteWithFiles());
    const f = await env.svc.pctx.readFile(p, 'src/index.ts');
    expect(f.content).toBe('export const x = 1;\n');
    expect((await env.svc.pctx.readFile(p, 'README.md')).content).not.toContain(GHP);
    for (const bad of ['.env', 'keys/server.pem', 'secret-notes.txt', '../etc/passwd', '/etc/passwd', '-rf', 'src/../../x']) await expect(env.svc.pctx.readFile(p, bad), bad).rejects.toThrow();
    await expect(env.svc.pctx.readFile(p, 'src/missing.ts')).rejects.toThrow(/does not exist/);
    await expect(env.svc.pctx.readFile(p, 'README.md', '--upload-pack=x')).rejects.toThrow(/valid branch/);
    expect((await env.svc.pctx.readFile(p, 'PROGRESS.md')).content.length).toBeLessThanOrEqual(60000);
  });

  it('serves a stale mirror with a warning when GitHub is unreachable', async () => {
    const env = makeEnv(); const remote = remoteWithFiles(); const p = addProject(env, remote);
    await env.svc.pctx.snapshot(p);
    execSync(`mv ${remote} ${remote}.moved`);
    const out = await env.svc.pctx.snapshot(p);
    expect(out).toMatch(/Could not refresh the repository/);
    expect(out).toContain('Demo app');
  });

  it('is fresh: a new commit shows up at the next call', async () => {
    const env = makeEnv(); const remote = remoteWithFiles(); const p = addProject(env, remote);
    await env.svc.pctx.snapshot(p);
    writeFileSync(path.join(remote, 'NOTES.md'), 'brand new notes');
    execSync('git add -A && git -c user.name=t -c user.email=t@t commit -qm "third commit"', { cwd: remote });
    expect(await env.svc.pctx.snapshot(p)).toMatch(/third commit[\s\S]*brand new notes|brand new notes[\s\S]*third commit/);
  });
});

describe('MCP', () => {
  it('serves get_project_context, read_project_file and the planning prompt through the official client', async () => {
    const env = makeEnv(); const p = addProject(env, remoteWithFiles());
    const c = await connect(env);
    const r: any = await c.callTool({ name: 'get_project_context', arguments: { project: p.name } });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('# Project demo');
    const f: any = await c.callTool({ name: 'read_project_file', arguments: { project: p.name, path: 'src/index.ts' } });
    expect(f.content[0].text).toContain('export const x = 1;');
    const bad: any = await c.callTool({ name: 'read_project_file', arguments: { project: p.name, path: '.env' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/secret/);
    const unknown: any = await c.callTool({ name: 'get_project_context', arguments: { project: 'nope' } });
    expect(unknown.isError).toBe(true);
    const prompts = await c.listPrompts();
    expect(prompts.prompts.map((x) => x.name)).toContain('plan_next_mission');
    const pr = await c.getPrompt({ name: 'plan_next_mission', arguments: { project: 'demo', goal: 'add billing' } });
    const text = (pr.messages[0].content as any).text as string;
    expect(text).toMatch(/get_project_context/); expect(text).toMatch(/create_task/); expect(text).toMatch(/success command/); expect(text).toContain('add billing');
    await c.close();
  });
});
