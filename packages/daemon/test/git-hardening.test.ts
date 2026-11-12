import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSandbox } from '../src/sandbox.js';
import { makeRemote } from './helpers.js';

describe('host-side git on a repository the agent controls', () => {
  it('never runs commands planted in .git/config and pushes only to the project url', async () => {
    const remote = makeRemote();
    const sb = new LocalSandbox(mkdtempSync(path.join(tmpdir(), 'bv-harden-')));
    await sb.prepareRepo({ repoUrl: remote, token: null, branch: 'agent/h', base: 'main' });
    const repo = path.join(sb.ws, 'repo');
    const marker = path.join(sb.ws, 'pwned');
    const evil = mkdtempSync(path.join(tmpdir(), 'bv-evil-'));
    execSync('git init --bare -q .', { cwd: evil });
    appendFileSync(path.join(repo, '.git/config'), `[core]\n\tfsmonitor = touch ${marker}\n[filter "x"]\n\tclean = touch ${marker}; cat\n[diff "x"]\n\ttextconv = touch ${marker}\n`);
    writeFileSync(path.join(repo, '.gitattributes'), '* filter=x diff=x\n');
    writeFileSync(path.join(repo, 'a.txt'), 'x');
    execSync(`git remote set-url --push origin ${evil}`, { cwd: repo });
    await sb.fingerprint();
    const a = await sb.mark();
    writeFileSync(path.join(repo, 'a.txt'), 'y');
    const b = await sb.mark();
    await sb.diffPatch(a!.snap, b!.snap, [], 0, 100);
    expect(existsSync(marker)).toBe(false);
    execSync('git add -A && git -c user.name=t -c user.email=t@t -c core.fsmonitor=false commit -qm work', { cwd: repo, env: { ...process.env } });
    await sb.push({ branch: 'agent/h', token: null, url: remote });
    expect(execSync('git branch --list agent/h', { cwd: remote }).toString()).toContain('agent/h');
    expect(execSync('git branch --list', { cwd: evil }).toString()).toBe('');
  });
});

describe('workspace file access', () => {
  it('refuses to follow a symbolic link planted by the agent', async () => {
    const { mkdirSync, symlinkSync, readFileSync } = await import('node:fs');
    const sb = new LocalSandbox(mkdtempSync(path.join(tmpdir(), 'bv-sym-')));
    const secret = path.join(mkdtempSync(path.join(tmpdir(), 'bv-secret-')), 's.txt');
    writeFileSync(secret, 'secret');
    mkdirSync(path.join(sb.ws, '.bivouac'), { recursive: true });
    symlinkSync(secret, path.join(sb.ws, '.bivouac/blocked.md'));
    await expect(sb.readFile('.bivouac/blocked.md')).rejects.toThrow(/symbolic link/);
    await expect(sb.tail('.bivouac/blocked.md')).rejects.toThrow(/symbolic link/);
    await expect(sb.writeFile('.bivouac/blocked.md', '')).rejects.toThrow(/symbolic link/);
    expect(readFileSync(secret, 'utf8')).toBe('secret');
  });
});
