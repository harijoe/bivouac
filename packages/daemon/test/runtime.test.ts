import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProjectConfig, titleFromPrompt } from '@bivouac/shared';
import { detectRuntime, miseConfig } from '../src/runtime.js';
import { addTask, makeEnv, makeRemote, taskDirOf } from './helpers.js';

describe('tool version detection (one case per source)', () => {
  const t = (files: Parameters<typeof detectRuntime>[0], o?: Record<string, string>) => detectRuntime(files, o).tools;
  it('.nvmrc and .node-version', () => {
    expect(t({ '.nvmrc': 'v20.11.1\n' })).toEqual({ node: '20.11.1' });
    expect(t({ '.node-version': '22\n' })).toEqual({ node: '22' });
    expect(t({ '.nvmrc': 'lts/*' })).toEqual({ node: 'lts' });
    expect(t({ '.nvmrc': 'lts/iron' })).toEqual({}); // an alias we cannot resolve is ignored, not guessed
  });
  it('package.json engines.node (lowest version of the range) and packageManager', () => {
    expect(t({ 'package.json': JSON.stringify({ engines: { node: '>=26' } }) })).toEqual({ node: '26' });
    expect(t({ 'package.json': JSON.stringify({ engines: { node: '^20.19 || ^22.12' } }) })).toEqual({ node: '20.19' });
    expect(t({ 'package.json': JSON.stringify({ packageManager: 'pnpm@11.0.1+sha512.abc' }) })).toEqual({ pnpm: '11.0.1' });
    expect(t({ 'package.json': '{ not json' })).toEqual({});
  });
  it('.tool-versions (with asdf aliases)', () => {
    expect(t({ '.tool-versions': 'nodejs 24.1.0\npython 3.12.2 3.11\ngolang 1.22 # comment\nruby system\n' })).toEqual({ node: '24.1.0', python: '3.12.2', go: '1.22' });
  });
  it('mise.toml', () => {
    expect(t({ 'mise.toml': '[tools]\nnode = "26"\npython = ["3.13", "3.12"]\ngo = { version = "1.23" }\n' })).toEqual({ node: '26', python: '3.13', go: '1.23' });
    expect(t({ '.mise.toml': '[tools]\nnode = "18"\n' })).toEqual({ node: '18' });
  });
  it('.python-version, go.mod, rust-toolchain(.toml)', () => {
    expect(t({ '.python-version': '3.11.4\n' })).toEqual({ python: '3.11.4' });
    expect(t({ 'go.mod': 'module x\n\ngo 1.22\n' })).toEqual({ go: '1.22' });
    expect(t({ 'go.mod': 'module x\n\ngo 1.22\ntoolchain go1.22.5\n' })).toEqual({ go: '1.22.5' });
    expect(t({ 'rust-toolchain.toml': '[toolchain]\nchannel = "1.75"\n' })).toEqual({ rust: '1.75' });
    expect(t({ 'rust-toolchain': 'stable\n' })).toEqual({ rust: 'stable' });
  });
  it('priority: engines < .nvmrc < .tool-versions < mise.toml < runtime of bivouac.yml', () => {
    const files = { 'package.json': JSON.stringify({ engines: { node: '>=18' } }), '.nvmrc': '20', '.tool-versions': 'nodejs 22', 'mise.toml': '[tools]\nnode = "24"\n' };
    expect(detectRuntime(files).tools.node).toBe('24');
    expect(detectRuntime(files).sources.node).toBe('mise.toml');
    expect(detectRuntime(files, { node: '26', python: '3.12' }).tools).toEqual({ node: '26', python: '3.12' });
    expect(detectRuntime({ '.tool-versions': 'nodejs 22' }).tools.node).toBe('22');
    expect(detectRuntime({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }), '.nvmrc': '20' }).tools.node).toBe('20');
  });
  it('never lets a hostile value reach the generated configuration', () => {
    const spec = detectRuntime({ '.nvmrc': '20"\n[settings]\nx = "1' , 'mise.toml': '[tools]\n"a b" = "1"\n' }, { 'x y': '1', node: '1"; rm' });
    expect(miseConfig(spec)).toBe('[tools]\n');
  });
});

describe('bivouac.yml runtime and image', () => {
  it('parses runtime (numbers accepted) and rejects bad values', () => {
    expect(parseProjectConfig('runtime:\n  node: 26\n  python: "3.12"\n').runtime).toEqual({ node: '26', python: '3.12' });
    expect(() => parseProjectConfig('runtime: [node]')).toThrow(/mapping/);
    expect(() => parseProjectConfig('runtime:\n  node: "26; rm -rf"\n')).toThrow(/invalid version/);
    expect(() => parseProjectConfig('runtime:\n  "No Way": 1\n')).toThrow(/tool name/);
  });
  it('refuses the removed image field with a clear error', () => {
    expect(() => parseProjectConfig('image: my/image:1\n')).toThrow(/no longer supported.*runtime/s);
  });
});

describe('task titles', () => {
  it('drop Markdown syntax', () => {
    expect(titleFromPrompt('# Analytics: add a **dashboard**\n\nDetails')).toBe('Analytics: add a dashboard');
    expect(titleFromPrompt('\n\n## `Fix` the [login page](http://x.y) _now_')).toBe('Fix the login page now');
    expect(titleFromPrompt('- [ ] add tests')).toBe('[ ] add tests');
    expect(titleFromPrompt('```\ncode\n```')).toBe('code');
    expect(titleFromPrompt('')).toBe('Untitled task');
    expect(titleFromPrompt('snake_case_name stays')).toBe('snake_case_name stays');
  });
});

describe('runtime in a task (stub mise)', () => {
  const oldPath = process.env.PATH;
  afterEach(() => { process.env.PATH = oldPath; });
  function stubMise() {
    const bin = mkdtempSync(path.join(tmpdir(), 'bv-mise-'));
    const log = path.join(bin, 'calls.log');
    writeFileSync(path.join(bin, 'mise'), `#!/bin/sh\necho "$@" >> ${log}\ncat "$PWD/.bivouac/mise.toml" >> ${log}\n[ -n "$MISE_FAIL" ] && { echo "mise: node@99 not found" >&2; exit 1; }\nexit 0\n`);
    chmodSync(path.join(bin, 'mise'), 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    return log;
  }
  const run = async (env: ReturnType<typeof makeEnv>, id: number) => { env.mgr.enqueue(id); await env.mgr.settled(id); return env.store.getTask(id)!; };

  it('installs what the repository declares, once, and tells the agent', async () => {
    const log = stubMise();
    const env = makeEnv();
    const remote = makeRemote({ 'README.md': 'x', '.nvmrc': '26\n', 'package.json': JSON.stringify({ packageManager: 'pnpm@11.0.1' }) });
    const t = addTask(env, remote, { prompt: 'x', success: 'true' });
    expect((await run(env, t.id)).status).toBe('succeeded');
    const calls = readFileSync(log, 'utf8');
    expect(calls.match(/^install$/gm)?.length).toBe(1); // later sessions find the same versions and do nothing
    expect(calls).toContain('node = "26"');
    expect(calls).toContain('pnpm = "11.0.1"');
    const prompts = readFileSync(path.join(taskDirOf(env, t), 'workspace/repo/.bivouac/fake-prompts.log'), 'utf8');
    expect(prompts).toMatch(/node 26/); expect(prompts).toMatch(/pnpm 11\.0\.1/);
    expect(prompts).toMatch(/blocked\.md/);
    expect(env.store.listEvents(t.id).some((e) => e.data.subtype === 'runtime')).toBe(true);
  });
  it('runtime in bivouac.yml wins over the repository', async () => {
    const log = stubMise();
    const env = makeEnv();
    const remote = makeRemote({ 'README.md': 'x', '.nvmrc': '20\n' });
    const t = addTask(env, remote, { prompt: 'x', config: { runtime: { node: '26' } } });
    await run(env, t.id);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('node = "26"'); expect(calls).not.toContain('"20"');
  });
  it('does nothing when the repository declares nothing', async () => {
    const log = stubMise();
    const env = makeEnv();
    const t = addTask(env, makeRemote(), { prompt: 'x' });
    expect((await run(env, t.id)).status).toBe('succeeded');
    expect(existsSync(log)).toBe(false);
  });
  it('fails with mise’s output when a version cannot be installed', async () => {
    stubMise(); process.env.MISE_FAIL = '1';
    try {
      const env = makeEnv();
      const t = addTask(env, makeRemote({ 'README.md': 'x', '.nvmrc': '99\n' }), { prompt: 'x' });
      const r = await run(env, t.id);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/node 99/); expect(r.error).toMatch(/not found/);
    } finally { delete process.env.MISE_FAIL; }
  });
});

describe('cost label', () => {
  it('is an API-equivalent estimate with a subscription and a real cost with an API key', async () => {
    const sub = makeEnv({ oauthToken: 'sk-ant-oat01-x', apiKey: null });
    expect(sub.svc.costKind()).toBe('estimated_api_equivalent');
    const t = addTask(sub, makeRemote(), { prompt: 'x' });
    expect(sub.svc.summary(sub.store.getTask(t.id)!).costKind).toBe('estimated_api_equivalent');
    const r = await sub.call('GET', `/api/tasks/${t.id}`);
    expect((await r.json()).costKind).toBe('estimated_api_equivalent');
    expect(makeEnv({ apiKey: 'sk-ant-api03-x' }).svc.costKind()).toBe('cost');
  });
});
