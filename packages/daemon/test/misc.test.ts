import { describe, it, expect } from 'vitest';
import { buildTraefikConfig, previewUrl, previewHost } from '../src/routes.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { buildRetryPrompt, buildInitialPrompt } from '../src/prompt.js';
import { parseMemory } from '../src/sandbox.js';
import { parseGithubRepo } from '../src/git.js';
import { makeEnv } from './helpers.js';
import { randomBytes } from 'node:crypto';

const cfg = { domain: '1-2-3-4.sslip.io', previewScheme: 'https' as const, previewPort: 443, certResolver: 'le', webHost: 'bivouac-web', namePrefix: 'bivouac', port: 3000, internalPort: 3001 };
describe('traefik dynamic config', () => {
  it('routes the dashboard and each task through forwardAuth', () => {
    const c = buildTraefikConfig(cfg, [{ id: 42, name: 'login-page', project: 'mon-app', devPort: 5173 }, { id: 43, name: 'not-started', project: 'mon-app', devPort: null }]);
    expect(c.http.routers['bivouac-web'].rule).toBe('Host(`1-2-3-4.sslip.io`)');
    const r = c.http.routers['bivouac-t42'];
    expect(r.rule).toBe('Host(`login-page.mon-app.1-2-3-4.sslip.io`)');
    expect(r.middlewares).toEqual(['bivouac-preview-auth']);
    expect(r.tls).toEqual({ certResolver: 'le' });
    expect(c.http.services['bivouac-t42'].loadBalancer.servers[0].url).toBe('http://bivouac-task-42:5173');
    expect(c.http.routers['bivouac-t43']).toBeUndefined();
    const fa = c.http.middlewares['bivouac-preview-auth'].forwardAuth;
    expect(fa.address).toBe('http://bivouac-web:3001/internal/preview-auth');
    expect(fa.authResponseHeaders).toEqual(['Cookie']);
  });
  it('a rename changes the route only', () => {
    const a = buildTraefikConfig(cfg, [{ id: 1, name: 'one', project: 'p', devPort: 80 }]);
    const b = buildTraefikConfig(cfg, [{ id: 1, name: 'two', project: 'p', devPort: 80 }]);
    expect(a.http.routers['bivouac-t1'].rule).toContain('one.p.');
    expect(b.http.routers['bivouac-t1'].rule).toContain('two.p.');
    expect(a.http.services['bivouac-t1']).toEqual(b.http.services['bivouac-t1']);
  });
  it('plain http mode has no TLS', () => {
    const c = buildTraefikConfig({ ...cfg, previewScheme: 'http' }, [{ id: 1, name: 'a', project: 'p', devPort: 80 }]);
    expect(c.http.routers['bivouac-t1'].tls).toBeUndefined();
    expect(c.http.routers['bivouac-t1'].entryPoints).toEqual(['web']);
  });
  it('builds URLs', () => {
    expect(previewHost(cfg, 'mon-app', 'login')).toBe('login.mon-app.1-2-3-4.sslip.io');
    expect(previewUrl(cfg, 'a', 'x')).toBe('https://x.a.1-2-3-4.sslip.io');
    expect(previewUrl({ ...cfg, previewPort: 8443 }, 'a', 'x')).toBe('https://x.a.1-2-3-4.sslip.io:8443');
  });
});
describe('misc', () => {
  it('encrypts round trip and rejects tampering', () => {
    const k = randomBytes(32);
    const e = encrypt(k, 'ghp_secret');
    expect(e).not.toContain('ghp');
    expect(decrypt(k, e)).toBe('ghp_secret');
    expect(() => decrypt(randomBytes(32), e)).toThrow();
  });
  it('secrets are not stored in clear in sqlite', () => {
    const env = makeEnv();
    env.store.createProject({ name: 'p', repoUrl: 'x', defaultBranch: 'main', githubToken: 'ghp_plain_token_value' });
    const raw = env.store.db.prepare('SELECT github_token_enc FROM projects').get() as any;
    expect(raw.github_token_enc).not.toContain('plain_token');
    expect(env.store.getProjectToken(1)).toBe('ghp_plain_token_value');
    expect(env.store.getProject(1)!.hasGithubToken).toBe(true);
    expect(JSON.stringify(env.store.getProject(1))).not.toContain('plain_token');
  });
  it('prompts include context and truncated failure', () => {
    const p = buildInitialPrompt({ prompt: 'Add button', branch: 'agent/t-1-x', baseBranch: 'main', previewUrl: 'http://t-1.p.d', devCommand: 'pnpm dev', devLogPath: '/workspace/.bivouac/dev.log', successCommand: 'pnpm test', iteration: 1, maxIterations: 5 });
    for (const s of ['Add button', 'agent/t-1-x', 'http://t-1.p.d', 'hot reload', 'dev.log', 'pnpm test', 'Commit regularly']) expect(p).toContain(s);
    const r = buildRetryPrompt({ checkOutput: 'x'.repeat(50000) + 'FAILED-AT-END', exitCode: 1, successCommand: 'pnpm test', instructions: ['be nice'], iteration: 2, maxIterations: 5 });
    expect(r.length).toBeLessThan(7000); expect(r).toContain('FAILED-AT-END'); expect(r).toContain('be nice');
  });
  it('parses memory and github urls', () => {
    expect(parseMemory('4g')).toBe(4 * 1024 ** 3); expect(parseMemory('512m')).toBe(512 * 1024 ** 2);
    expect(parseGithubRepo('https://github.com/a/b.git')).toEqual({ owner: 'a', repo: 'b' });
    expect(parseGithubRepo('https://example.com/a/b')).toBeNull();
  });
});
