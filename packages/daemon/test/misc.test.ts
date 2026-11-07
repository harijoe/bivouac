import { describe, it, expect } from 'vitest';
import { traefikLabels, previewUrl, previewHost } from '../src/labels.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { buildRetryPrompt, buildInitialPrompt } from '../src/prompt.js';
import { parseMemory } from '../src/sandbox.js';
import { parseGithubRepo } from '../src/git.js';
import { makeEnv } from './helpers.js';
import { randomBytes } from 'node:crypto';

const cfg = { domain: '100-64-1-2.sslip.io', previewScheme: 'http' as const, previewPort: 80, certResolver: null };
describe('traefik labels', () => {
  it('generates router, service and network labels', () => {
    const l = traefikLabels(cfg, { taskId: 42, project: 'mon-app', port: 5173, network: 'bivouac-task-42' });
    expect(l['traefik.http.routers.bivouac-t42.rule']).toBe('Host(`t-42.mon-app.100-64-1-2.sslip.io`)');
    expect(l['traefik.http.services.bivouac-t42.loadbalancer.server.port']).toBe('5173');
    expect(l['traefik.docker.network']).toBe('bivouac-task-42');
    expect(l['traefik.http.routers.bivouac-t42.entrypoints']).toBe('web');
    expect(Object.keys(l).some((k) => k.includes('tls'))).toBe(false);
  });
  it('adds TLS and basic auth', () => {
    const l = traefikLabels({ ...cfg, previewScheme: 'https', certResolver: 'le' }, { taskId: 1, project: 'p', port: 80, network: 'n', publicAuth: { user: 'u', htpasswdHash: '{SHA}a$b' } });
    expect(l['traefik.http.routers.bivouac-t1.tls.certresolver']).toBe('le');
    expect(l['traefik.http.routers.bivouac-t1.entrypoints']).toBe('websecure');
    expect(l['traefik.http.middlewares.bivouac-t1-auth.basicauth.users']).toBe('u:{SHA}a$$b');
    expect(l['traefik.http.routers.bivouac-t1.middlewares']).toBe('bivouac-t1-auth');
  });
  it('builds URLs', () => {
    expect(previewHost(cfg, 'mon-app', 42)).toBe('t-42.mon-app.100-64-1-2.sslip.io');
    expect(previewUrl(cfg, 'a', 1)).toBe('http://t-1.a.100-64-1-2.sslip.io');
    expect(previewUrl({ ...cfg, previewPort: 8080 }, 'a', 1)).toBe('http://t-1.a.100-64-1-2.sslip.io:8080');
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
