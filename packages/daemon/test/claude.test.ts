import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loginState, parseLoginUrl, parseToken, stripAnsi } from '../src/claude.js';
import type { LoginClient } from '../src/context.js';
import { typeCode, type LoginSession } from '../src/executor.js';
import { FAKE_CLAUDE, makeEnv } from './helpers.js';

const REAL = readFileSync(new URL('./fixtures/setup-token.out', import.meta.url), 'utf8');
/** Captured from the real CLI 2.1.319 (a 92-character code sent as text, then Enter): the answer is an OAuth error. */
const REJECTED = readFileSync(new URL('./fixtures/setup-token-rejected.out', import.meta.url), 'utf8');

/** Runs the fake CLI as a child process: same stdin/stdout protocol as the container session. */
class LocalLogin implements LoginClient {
  private s = new Map<string, LoginSession & { p: ChildProcess }>();
  async loginStart() {
    const p = spawn('node', [FAKE_CLAUDE, 'setup-token'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const id = String(this.s.size + 1);
    const s = { id, output: '', done: false, exitCode: null as number | null, inputAt: 0, p };
    p.stdout.on('data', (b) => (s.output += b.toString()));
    p.on('close', (c) => { s.done = true; s.exitCode = c; });
    this.s.set(id, s);
    return { id, output: '', done: false, exitCode: null, inputAt: 0 };
  }
  async loginGet(id: string) { const { p: _p, ...rest } = this.s.get(id)!; return rest; }
  async loginInput(id: string, text: string) { const s = this.s.get(id)!; s.inputAt = s.output.length; await typeCode((d) => s.p.stdin!.write(d), text, 30); }
  async loginCancel(id: string) { this.s.get(id)?.p.kill(); }
}

describe('claude setup-token parsing (real captured output)', () => {
  it('extracts the sign-in URL from the terminal hyperlink', () => {
    const url = parseLoginUrl(REAL)!;
    expect(url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=/);
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toMatch(/state=[A-Za-z0-9_-]+$/); // complete, not cut at the terminal width
    expect(url).not.toMatch(/\s/); expect(url.includes('\u001b')).toBe(false);
  });
  it('falls back to wrapped plain text when there is no hyperlink', () => {
    const plain = stripAnsi(REAL).replace(/\]8;[^\n]*/g, '');
    const text = 'Use the url below\n\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc&re\nsponse_type=code&state=xyz\n\nPaste code here if prompted >';
    expect(parseLoginUrl(text)).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz');
    expect(plain).toContain('Paste');
  });
  it('detects the prompt and the token (even wrapped over two lines)', async () => {
    expect((await loginState(REAL, false, null)).phase).toBe('waiting_code');
    expect((await loginState('Welcome to Claude Code', false, null)).phase).toBe('starting');
    const tok = 'sk-ant-oat01-' + 'A1b2C3d4'.repeat(12);
    const wrapped = `Your token:\r\n\r\n${tok.slice(0, 80)}\r\n${tok.slice(80)}\r\n\r\nStore it safely.\r\n`;
    expect(await parseToken(wrapped)).toBe(tok);
    expect(await loginState(REAL + wrapped, false, null)).toMatchObject({ phase: 'done', token: tok });
    expect((await loginState(REAL, true, 1)).phase).toBe('error');
  });
  it('rebuilds a token the CLI drew by skipping unchanged cells (no lost character)', async () => {
    const tok = 'sk-ant-oat01-' + 'Zy9Xw8Vu'.repeat(11);
    // What the CLI does: the line is on screen already (other text), then only the cells that differ are rewritten and
    // the rest is jumped over with ESC[nC. Here the "o" of "oat01" and a stretch in the middle are unchanged cells.
    const old = tok.split('');
    for (const i of [4, 5, 6, 8, 9, 30, 31, 32, 50, 51]) old[i] = '#';
    const oldText = old.join('');
    let draw = '', skip = 0;
    for (let i = 0; i < tok.length; i++) {
      if (tok[i] === oldText[i]) { skip++; continue; }
      if (skip) { draw += `\x1b[${skip}C`; skip = 0; }
      draw += tok[i];
    }
    const raw = `${oldText}\r${draw}\r\n`;
    expect(raw).toMatch(/\x1b\[\d+C/);
    const naive = raw.replace(/\x1b\[\d*C/g, ' ').split('\r')[1];
    expect(naive).not.toContain(tok); // what the old regex-only parsing saw
    expect(await parseToken(raw)).toBe(tok);
  });
  it('refuses a malformed token', async () => {
    const bad = 'sk-ant-at01-' + 'Q'.repeat(60);
    expect(await parseToken(`\r\n${bad}\r\n`)).toBeNull();
    expect(await loginState(`\r\n${bad}\r\n`, true, 0)).toMatchObject({ phase: 'error', message: expect.stringMatching(/malformed/) });
  });
  it('real CLI output after a refused code is an error with the CLI\'s own explanation, not "waiting for code"', async () => {
    const st = await loginState(REJECTED, false, null, REJECTED.indexOf('****'));
    expect(st.phase).toBe('error');
    expect(st.message).toMatch(/wasn't accepted/);
    expect(st.message).not.toMatch(/Press/);
    // the same screen before the code was sent is still just waiting
    expect((await loginState(REJECTED.slice(0, REJECTED.indexOf('****')), false, null)).phase).toBe('waiting_code');
    expect((await loginState(REJECTED.slice(0, REJECTED.indexOf('\x1b[2K')), false, null, REJECTED.indexOf('****'))).phase).toBe('verifying');
  });
});

describe('Connect Claude from the dashboard', () => {
  it('walks through URL → code → token stored encrypted', async () => {
    const env = makeEnv();
    env.ctx.login = new LocalLogin();
    env.cfg.oauthToken = null;
    expect(((await (await env.call('GET', '/api/claude')).json()) as any).connected).toBe(false);
    const { id } = (await (await env.call('POST', '/api/claude/login')).json()) as any;
    let st: any;
    for (let i = 0; i < 50; i++) { st = await (await env.call('GET', `/api/claude/login/${id}`)).json(); if (st.phase === 'waiting_code') break; await new Promise((r) => setTimeout(r, 50)); }
    expect(st.phase).toBe('waiting_code');
    expect(st.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize/);
    expect((await env.call('POST', `/api/claude/login/${id}/code`, { code: '' })).status).toBe(400);
    expect((await env.call('POST', `/api/claude/login/${id}/code`, { code: 'FAKE-CODE' })).status).toBe(200);
    for (let i = 0; i < 50; i++) { st = await (await env.call('GET', `/api/claude/login/${id}`)).json(); if (st.phase === 'done') break; await new Promise((r) => setTimeout(r, 50)); }
    expect(st).toEqual({ phase: 'done' }); // the token never goes back to the browser
    const status: any = await (await env.call('GET', '/api/claude')).json();
    expect(status).toMatchObject({ connected: true, kind: 'oauth', expired: false });
    expect(Date.parse(status.expiresAt) - Date.now()).toBeGreaterThan(364 * 86400_000);
    const raw = JSON.stringify(env.store.db.prepare('SELECT * FROM settings').all());
    expect(raw).not.toContain('sk-ant-oat01');
    expect(env.store.getSecretSetting('claude_oauth_token')).toMatch(/^sk-ant-oat01-FAKE/);
    expect(env.ctx.auth.listAudit().some((a) => a.action === 'claude_connected')).toBe(true);
  });

  it('stores the token by itself when the page never asks again (reload / closed tab)', async () => {
    const env = makeEnv();
    env.ctx.login = new LocalLogin();
    env.cfg.oauthToken = null;
    const { id } = (await (await env.call('POST', '/api/claude/login')).json()) as any;
    let st: any;
    for (let i = 0; i < 50; i++) { st = await (await env.call('GET', `/api/claude/login/${id}`)).json(); if (st.phase === 'waiting_code') break; await new Promise((r) => setTimeout(r, 50)); }
    // a code of real length, sent the way the dashboard does; then nobody polls the session
    await env.call('POST', `/api/claude/login/${id}/code`, { code: 'FAKE-CODE' });
    for (let i = 0; i < 80 && !env.store.getSecretSetting('claude_oauth_token'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(env.store.getSecretSetting('claude_oauth_token')).toMatch(/^sk-ant-oat01-FAKE/);
    expect(env.ctx.auth.listAudit().some((a) => a.action === 'claude_connected')).toBe(true);
    // the page comes back later and still gets a clean answer
    expect(await (await env.call('GET', `/api/claude/login/${id}`)).json()).toEqual({ phase: 'done' });
  });

  it('a long code is not lost: text first, Enter in a separate write', async () => {
    const env = makeEnv();
    env.ctx.login = new LocalLogin();
    const { id } = (await (await env.call('POST', '/api/claude/login')).json()) as any;
    await new Promise((r) => setTimeout(r, 300));
    const long = 'A'.repeat(86) + '#bbbbb';
    await env.call('POST', `/api/claude/login/${id}/code`, { code: long });
    let st: any;
    for (let i = 0; i < 50; i++) { st = await (await env.call('GET', `/api/claude/login/${id}`)).json(); if (st.phase === 'error') break; await new Promise((r) => setTimeout(r, 50)); }
    expect(st.phase).toBe('error'); // the fake CLI, like the real one, only answers after a lone Enter
    expect(st.message).toMatch(/did not accept that code/);
  });

  it('reports a wrong code as an actionable error', async () => {
    const env = makeEnv();
    env.ctx.login = new LocalLogin();
    const { id } = (await (await env.call('POST', '/api/claude/login')).json()) as any;
    await new Promise((r) => setTimeout(r, 300));
    await env.call('POST', `/api/claude/login/${id}/code`, { code: 'nope' });
    let st: any;
    for (let i = 0; i < 50; i++) { st = await (await env.call('GET', `/api/claude/login/${id}`)).json(); if (st.phase === 'error') break; await new Promise((r) => setTimeout(r, 50)); }
    expect(st.phase).toBe('error');
    expect(st.message).toMatch(/did not accept that code/);
  });

  it('API key alternative: validated, stored encrypted, replaces the token', async () => {
    const env = makeEnv();
    expect((await env.call('PUT', '/api/claude/apikey', { key: 'hello' })).status).toBe(400);
    env.cfg.oauthToken = null;
    const key = 'sk-ant-api03-' + 'x'.repeat(40);
    expect((await env.call('PUT', '/api/claude/apikey', { key })).status).toBe(200);
    expect(((await (await env.call('GET', '/api/claude')).json()) as any)).toMatchObject({ connected: true, kind: 'apikey' });
    expect(JSON.stringify(env.store.db.prepare('SELECT * FROM settings').all())).not.toContain('x'.repeat(40));
    await env.call('DELETE', '/api/claude');
    env.cfg.oauthToken = null;
    expect(((await (await env.call('GET', '/api/claude')).json()) as any).connected).toBe(false);
  });
});
