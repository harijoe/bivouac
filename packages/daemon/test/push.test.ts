import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSandbox } from '../src/sandbox.js';
import { pushFailureMessage } from '../src/service.js';
import { makeRemote } from './helpers.js';

describe('push_branch', () => {
  it('ignores the repository git hooks (a pre-push hook calling a tool the executor lacks must not block it)', async () => {
    const remote = makeRemote();
    const sb = new LocalSandbox(mkdtempSync(path.join(tmpdir(), 'bv-push-')));
    await sb.prepareRepo({ repoUrl: remote, token: null, branch: 'agent/hooked', base: 'main' });
    const repo = path.join(sb.ws, 'repo');
    mkdirSync(path.join(repo, '.githooks'));
    writeFileSync(path.join(repo, '.githooks/pre-push'), '#!/bin/sh\necho "pnpm: command not found" >&2\nexit 127\n');
    chmodSync(path.join(repo, '.githooks/pre-push'), 0o755);
    execSync('git config core.hooksPath .githooks', { cwd: repo });
    writeFileSync(path.join(repo, 'a.txt'), 'x');
    execSync('git add -A && git -c user.name=t -c user.email=t@t commit -qm work', { cwd: repo });
    // sanity: without --no-verify the hook does block a plain push
    expect(() => execSync('git push origin agent/hooked:probe', { cwd: repo, stdio: 'pipe' })).toThrow();
    await sb.push({ branch: 'agent/hooked', token: null });
    expect(execSync('git branch --list agent/hooked', { cwd: remote }).toString()).toContain('agent/hooked');
  });

  it('only blames permissions for a real authorization error', () => {
    expect(pushFailureMessage('git push failed: remote: Permission to a/b.git denied to bivouac[bot].\nfatal: unable to access: The requested URL returned error: 403')).toMatch(/needs write access/);
    expect(pushFailureMessage('git push failed: pre-push hook failed: pnpm: command not found')).not.toMatch(/GitHub App|write access/);
    expect(pushFailureMessage('git push failed: ! [rejected] a -> a (non-fast-forward)')).toMatch(/rebase/);
    expect(pushFailureMessage('git push failed: fatal: unable to access x: Could not resolve host: github.com')).toMatch(/could not be reached/);
  });
});
