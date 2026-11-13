import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProjectConfig } from '@bivouac/shared';
import { planMcp, redactValues, stripSkillHooks, fingerprintServer } from '../src/agent-tools.js';
import { redactData } from '../src/tooling.js';
import { ensureSkill } from '../src/skills.js';
import { LocalSandbox } from '../src/sandbox.js';
import { addTask, makeEnv, makeRemote, repoOf, taskDirOf } from './helpers.js';

const plan = (mcp: any, o: Partial<Parameters<typeof planMcp>[0]> = {}) => planMcp({ mcp: mcp ? parseProjectConfig('mcp: ' + JSON.stringify(mcp)).mcp : undefined, chromium: '/usr/bin/chromium', context7Key: null, secrets: {}, isApproved: () => false, ...o });

describe('mcp: section of bivouac.yml', () => {
  it('gives Playwright and Context7 by default, and nothing when both are switched off', () => {
    expect(Object.keys(plan(undefined).config.mcpServers)).toEqual(['playwright', 'context7']);
    const p = plan({ playwright: false, context7: false });
    expect(p.config.mcpServers).toEqual({});
    expect(p.entries).toEqual([]);
  });

  it('points Playwright at the image Chromium, headless', () => {
    const pw: any = plan(undefined).config.mcpServers.playwright;
    expect(pw.args).toEqual(expect.arrayContaining(['--headless', '--executable-path', '/usr/bin/chromium']));
  });

  it('rejects definitions that could leak or are ambiguous', () => {
    const bad = (y: string) => expect(() => parseProjectConfig(y)).toThrow();
    bad('mcp:\n  s: { command: npx, url: "https://x.test" }');
    bad('mcp:\n  s: { url: "https://x.test", headers: { A: "${CLAUDE_CODE_OAUTH_TOKEN}" } }');
    bad('mcp:\n  s: { url: "https://x.test", headers: { A: "${OTHER}" }, secrets: [TOKEN] }');
    bad('mcp:\n  playwright: { command: node }');
    bad('mcp:\n  s: { url: "file:///etc/passwd" }');
    bad('skills: [not-in-catalogue]');
    expect(parseProjectConfig('skills: [taste-skill, taste-skill]').skills).toEqual(['taste-skill']);
  });

  it('never puts a secret value in the config, only references; the values go to the environment', () => {
    const spec = parseProjectConfig('mcp:\n  docs:\n    url: https://docs.test/mcp\n    headers: { Authorization: "Bearer ${DOCS_TOKEN}" }\n    secrets: [DOCS_TOKEN]\n  tool:\n    command: npx\n    args: ["-y", "tool@1.0.0"]\n    secrets: [TOOL_KEY]').mcp!;
    const secrets = { DOCS_TOKEN: 'docs-secret-value', TOOL_KEY: 'tool-secret-value' };
    const p = planMcp({ mcp: spec, chromium: 'c', context7Key: 'ctx7-secret-key', secrets, isApproved: () => true });
    const json = JSON.stringify(p.config);
    for (const v of [...Object.values(secrets), 'ctx7-secret-key']) expect(json).not.toContain(v);
    expect(p.env).toMatchObject({ BIVOUAC_MCP_SECRET_DOCS_TOKEN: 'docs-secret-value', BIVOUAC_MCP_SECRET_TOOL_KEY: 'tool-secret-value', BIVOUAC_CONTEXT7_API_KEY: 'ctx7-secret-key' });
    expect((p.config.mcpServers.docs as any).headers.Authorization).toBe('Bearer ${BIVOUAC_MCP_SECRET_DOCS_TOKEN}');
    expect((p.config.mcpServers.tool as any).env.TOOL_KEY).toBe('${BIVOUAC_MCP_SECRET_TOOL_KEY}');
  });

  it('withholds a server with secrets until its exact definition is approved, and when a secret is missing', () => {
    const y = 'mcp:\n  docs: { url: "https://docs.test/mcp", secrets: [DOCS_TOKEN] }';
    const spec = parseProjectConfig(y).mcp!;
    const seen: string[] = [];
    const a = planMcp({ mcp: spec, chromium: 'c', context7Key: null, secrets: { DOCS_TOKEN: 'v-value-1' }, isApproved: () => false, seen: (_n, fp) => seen.push(fp) });
    expect(a.config.mcpServers.docs).toBeUndefined();
    expect(a.entries.find((e) => e.name === 'docs')).toMatchObject({ status: 'skipped' });
    expect(a.env).toEqual({});
    const fp = fingerprintServer('docs', spec.servers!.docs);
    expect(seen).toEqual([fp]);
    const b = planMcp({ mcp: spec, chromium: 'c', context7Key: null, secrets: {}, isApproved: (_n, f) => f === fp });
    expect(b.warnings[0]).toContain('DOCS_TOKEN');
    const changed = parseProjectConfig(y.replace('docs.test', 'evil.test')).mcp!;
    expect(planMcp({ mcp: changed, chromium: 'c', context7Key: null, secrets: { DOCS_TOKEN: 'v-value-1' }, isApproved: (_n, f) => f === fp }).config.mcpServers.docs).toBeUndefined();
  });

  it('redacts secret values from agent output', () => {
    const out = redactData({ text: 'token is sk-secret-123 and "quoted\\"x"', n: 1 }, ['sk-secret-123']) as any;
    expect(JSON.stringify(out)).not.toContain('sk-secret-123');
    expect(out.n).toBe(1);
    expect(redactValues('a abc b', ['abc'])).toBe('a abc b');
  });
});

describe('skills', () => {
  const taste = `---\nname: design-taste-frontend\ndescription: >-\n  A long\n  description.\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: 'exec node gate.mjs'\n          timeout: 600\nlicense: MIT\n---\n\n# Body\nhooks: stays in the body\n`;

  it('removes the hooks block from the front matter only', () => {
    const r = stripSkillHooks(taste);
    expect(r.removed).toBe(true);
    expect(r.text).toContain('description: >-\n  A long\n  description.\nlicense: MIT\n---');
    expect(r.text).not.toContain('gate.mjs');
    expect(r.text).toContain('hooks: stays in the body');
    expect(stripSkillHooks('---\nname: x\n---\nbody').removed).toBe(false);
  });

  function skillRepo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'bv-skill-'));
    mkdirSync(path.join(dir, 'skills', 'taste'), { recursive: true });
    writeFileSync(path.join(dir, 'skills', 'taste', 'SKILL.md'), taste);
    writeFileSync(path.join(dir, 'skills', 'taste', 'extra.txt'), 'x');
    execSync('ln -s /etc/passwd skills/taste/link && git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm i', { cwd: dir });
    const commit = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    return { dir, commit };
  }

  it('installs a pinned skill from the cache without its hooks and without links, and tells a missing one apart', async () => {
    const { dir, commit } = skillRepo();
    const cat = { 'taste-skill': { repo: dir, commit, path: 'skills/taste', dir: 'design-taste-frontend', license: 'MIT' }, 'gone': { repo: dir, commit, path: 'skills/none', dir: 'gone', license: 'MIT' } };
    const ws = mkdtempSync(path.join(tmpdir(), 'bv-ws-'));
    const sb = new LocalSandbox(path.join(ws, 'p', 'tasks', 't-1', 'workspace'));
    sb.setCatalogue(cat);
    const res = await sb.installSkills(['taste-skill', 'gone', 'unknown']);
    expect(res.map((r) => [r.name, r.ok])).toEqual([['taste-skill', true], ['gone', false], ['unknown', false]]);
    const md = readFileSync(path.join(sb.skillsHome, 'design-taste-frontend', 'SKILL.md'), 'utf8');
    expect(md).not.toContain('gate.mjs');
    expect(readFileSync(path.join(sb.skillsHome, 'design-taste-frontend', 'extra.txt'), 'utf8')).toBe('x');
    expect(() => readFileSync(path.join(sb.skillsHome, 'design-taste-frontend', 'link'))).toThrow();
    const again = await ensureSkill(path.join(ws, 'skills'), 'taste-skill', cat['taste-skill']);
    expect(again.hooksRemoved).toBe(true);
  });
});

describe('what the agent receives in a task', () => {
  const run = async (env: ReturnType<typeof makeEnv>, id: number) => { env.mgr.enqueue(id); await env.mgr.settled(id); return env.store.getTask(id)!; };
  const argsLog = (env: ReturnType<typeof makeEnv>, t: { id: number }) => readFileSync(path.join(repoOf(env, t), '.bivouac', 'fake-args.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('passes the defaults, lists them on the task, and tells the agent', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it' });
    const r = await run(env, t.id);
    expect(r.status).toBe('succeeded');
    const [call] = argsLog(env, t);
    const cfg = JSON.parse(call.argv[call.argv.indexOf('--mcp-config') + 1]);
    expect(Object.keys(cfg.mcpServers)).toEqual(['playwright', 'context7']);
    expect(r.tooling!.mcp.map((m) => m.name)).toEqual(['playwright', 'context7']);
    expect(env.svc.summary(r).tooling).toEqual(r.tooling);
    const prompts = readFileSync(path.join(repoOf(env, t), '.bivouac', 'fake-prompts.log'), 'utf8');
    expect(prompts).toContain('checked on the running preview');
    expect(prompts).toContain('playwright');
  });

  it('passes no --mcp-config when both defaults are off, and says nothing about the browser', async () => {
    const env = makeEnv(); const remote = makeRemote({ 'README.md': 'x\n', 'bivouac.yml': 'mcp: { playwright: false, context7: false }\n' });
    const t = addTask(env, remote, { prompt: 'do it' });
    const r = await run(env, t.id);
    expect(argsLog(env, t)[0].argv).not.toContain('--mcp-config');
    expect(r.tooling!.mcp).toEqual([]);
    expect(readFileSync(path.join(repoOf(env, t), '.bivouac', 'fake-prompts.log'), 'utf8')).not.toContain('checked on the running preview');
  });

  it('hands project secrets to an approved server through the environment only, and never exposes them', async () => {
    const env = makeEnv(); const remote = makeRemote({ 'README.md': 'x\n', 'bivouac.yml': 'mcp:\n  docs: { url: "https://docs.test/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, secrets: [DOCS_TOKEN] }\n' });
    const t = addTask(env, remote, { prompt: 'do it' });
    const SECRET = 'docs-token-VALUE-12345';
    expect((await env.call('PUT', `/api/projects/${t.projectId}/mcp/secrets/DOCS_TOKEN`, { value: SECRET })).status).toBe(200);
    let r = await run(env, t.id);
    expect(r.tooling!.mcp.find((m) => m.name === 'docs')).toMatchObject({ status: 'skipped' });
    expect(argsLog(env, t)[0].env.BIVOUAC_MCP_SECRET_DOCS_TOKEN).toBeUndefined();

    const list = await (await env.call('GET', `/api/projects/${t.projectId}/mcp`)).json() as any;
    expect(list.servers).toHaveLength(1);
    expect((await env.call('POST', `/api/projects/${t.projectId}/mcp/servers/${list.servers[0].fingerprint}/approve`)).status).toBe(200);
    env.store.patchTask(t.id, { iteration: 0 });
    await env.mgr.resume(t.id, 'again'); await env.mgr.settled(t.id);
    r = env.store.getTask(t.id)!;
    expect(r.tooling!.mcp.find((m) => m.name === 'docs')).toMatchObject({ status: 'configured' });
    const last = argsLog(env, t).at(-1)!;
    expect(last.env.BIVOUAC_MCP_SECRET_DOCS_TOKEN).toBe(SECRET);
    expect(JSON.stringify(last.argv)).not.toContain(SECRET);

    const everything = JSON.stringify([
      await (await env.call('GET', `/api/projects/${t.projectId}/mcp`)).json(),
      await (await env.call('GET', `/api/tasks/${t.id}`)).json(),
      await (await env.call('GET', '/api/settings')).json(),
      env.store.listEvents(t.id), env.svc.summary(r),
    ]);
    expect(everything).not.toContain(SECRET);
  });

  it('keeps the Context7 key write-only', async () => {
    const env = makeEnv();
    expect((await env.call('PUT', '/api/settings/context7', { apiKey: 'ctx7sk-abcdef' })).status).toBe(200);
    const s = await (await env.call('GET', '/api/settings')).json() as any;
    expect(s.context7).toEqual({ configured: true });
    expect(JSON.stringify(s)).not.toContain('ctx7sk-abcdef');
    const t = addTask(env, makeRemote(), { prompt: 'do it' });
    await run(env, t.id);
    expect(argsLog(env, t)[0].env.BIVOUAC_CONTEXT7_API_KEY).toBe('ctx7sk-abcdef');
    expect(JSON.stringify(argsLog(env, t)[0].argv)).not.toContain('ctx7sk-abcdef');
    void taskDirOf;
  });
});
