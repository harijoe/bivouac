import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SkillEntry } from '@bivouac/shared';
import { git } from './git.js';
import { stripSkillHooks } from './agent-tools.js';

export interface SkillResult { name: string; ok: boolean; error?: string; hooksRemoved?: boolean }

function copyPlain(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyPlain(s, d);
    else if (e.isFile()) cpSync(s, d);
  }
}

/**
 * The skill at its pinned commit, from the server's cache (one fetch per commit, ever). Only regular files are kept (no links),
 * nothing from the repository is executed, and the `hooks:` block of SKILL.md is removed so a skill cannot run commands of its own
 * at the end of a session. Returns the directory holding the skill's files.
 */
export async function ensureSkill(cacheDir: string, name: string, entry: SkillEntry): Promise<{ dir: string; hooksRemoved: boolean }> {
  const key = `${name}-${entry.commit.slice(0, 12)}`;
  const ready = path.join(cacheDir, key);
  const marker = path.join(ready, '.bivouac-ok');
  const files = path.join(ready, 'skill');
  if (existsSync(marker)) return { dir: files, hooksRemoved: readFileSync(marker, 'utf8') === 'hooks-removed' };
  mkdirSync(cacheDir, { recursive: true });
  const work = path.join(cacheDir, `.tmp-${key}-${process.pid}-${Date.now()}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const src = path.join(work, 'src');
    for (const args of [['init', '-q', src], ['-C', src, 'fetch', '-q', '--depth', '1', entry.repo, entry.commit], ['-C', src, 'checkout', '-q', '--detach', 'FETCH_HEAD']]) {
      const r = await git(args, { env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-') && a !== src) ?? ''} failed: ${r.stderr.trim().split('\n').pop()}`);
    }
    const from = path.resolve(src, entry.path);
    if (!from.startsWith(src + path.sep) || !existsSync(from) || lstatSync(from).isSymbolicLink()) throw new Error(`path ${entry.path} not found at commit ${entry.commit.slice(0, 12)}`);
    const out = path.join(work, 'skill');
    copyPlain(from, out);
    const md = path.join(out, 'SKILL.md');
    if (!existsSync(md)) throw new Error('SKILL.md missing');
    const stripped = stripSkillHooks(readFileSync(md, 'utf8'));
    if (stripped.removed) writeFileSync(md, stripped.text);
    rmSync(src, { recursive: true, force: true });
    writeFileSync(path.join(work, '.bivouac-ok'), stripped.removed ? 'hooks-removed' : 'plain');
    rmSync(ready, { recursive: true, force: true });
    renameSync(work, ready);
    return { dir: files, hooksRemoved: stripped.removed };
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
}
