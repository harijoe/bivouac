import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loginState, parseLoginUrl, parseToken, stripAnsi } from '../src/claude.js';
import type { LoginClient } from '../src/context.js';
import type { LoginSession } from '../src/executor.js';
import { FAKE_CLAUDE, makeEnv } from './helpers.js';

const REAL = readFileSync(new URL('./fixtures/setup-token.out', import.meta.url), 'utf8');

/** Runs the fake CLI as a child process: same stdin/stdout protocol as the container session. */
class LocalLogin implements LoginClient {
  private s = new Map<string, LoginSession & { p: ChildProcess }>();
  async loginStart() {
    const p = spawn('node', [FAKE_CLAUDE, 'setup-token'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const id = String(this.s.size + 1);
    const s = { id, output: '', done: false, exitCode: null as number | null, p };
    p.stdout.on('data', (b) => (s.output += b.toString()));
    p.on('close', (c) => { s.done = true; s.exitCode = c; });
    this.s.set(id, s);
    return { id, output: '', done: false, exitCode: null };
  }
  async loginGet(id: string) { const { p: _p, ...rest } = this.s.get(id)!; return rest; }
  async loginInput(id: string, text: string) { this.s.get(id)!.p.stdin!.write(text + '\n'); }
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
  it('detects the prompt and the token (even wrapped over two lines)', () => {
    expect(loginState(REAL, false, null).phase).toBe('waiting_code');
    expect(loginState('Welcome to Claude Code', false, null).phase).toBe('starting');
    const tok = 'sk-ant-oat01-' + 'A1b2C3d4'.repeat(12);
    const wrapped = `Your token:\r\n\r\n${tok.slice(0, 80)}\r\n${tok.slice(80)}\r\n\r\nStore it safely.\r\n`;
    expect(parseToken(wrapped)).toBe(tok);
    expect(loginState(REAL + wrapped, false, null)).toMatchObject({ phase: 'done', token: tok });
    expect(loginState(REAL, true, 1).phase).toBe('error');
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

  it('reports a wrong code as an actionable error', async () => {
    const env = makeEnv();
    env.ctx.login = new LocalLogin();
    const { id } = (await (await env.call('POST', '/api/claude/login')).json()) as any;
    await new Promise((r) => setTimeout(r, 300));
    await env.call('POST', `/api/claude/login/${id}/code`, { code: 'nope' });
    let st: any;
    for (let i = 0; i < 50; i++) { st = await (await env.call('GET', `/api/claude/login/${id}`)).json(); if (st.phase === 'error') break; await new Promise((r) => setTimeout(r, 50)); }
    expect(st.phase).toBe('error');
    expect(st.message).toMatch(/without a token/);
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
