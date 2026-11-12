import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Environment snapshots: what `setup` leaves behind that git ignores (node_modules, virtualenvs, vendored gems, build caches),
 * archived once per fingerprint and unpacked into the next task of the project before its `setup` runs. `setup` always runs
 * afterwards, so a stale or damaged snapshot only costs time, never correctness (see docs/decisions.md).
 */

/** Files whose content decides what `setup` installs. A project without any of them gets no snapshot (nothing says when it goes stale). */
export const LOCK_FILES = [
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'requirements.txt', 'requirements-dev.txt', 'Gemfile.lock', 'Cargo.lock', 'go.sum', 'composer.lock',
  // settings that change what an install produces
  '.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.yarnrc.yml', 'pyproject.toml', 'Gemfile', 'Cargo.toml', 'go.mod', 'package.json',
] as const;
const LOCKS = new Set<string>(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'requirements.txt', 'requirements-dev.txt', 'Gemfile.lock', 'Cargo.lock', 'go.sum', 'composer.lock']);
/** Snapshots kept per project (the least recently used go first) and the size above which one is not kept. */
export const SNAPSHOT_KEEP = Number(process.env.BIVOUAC_SNAPSHOT_KEEP ?? 3) || 3;
export const SNAPSHOT_MAX_BYTES = 3 * 1024 ** 3;

/** package.json counts through its dependency fields only: renaming a script must not throw the snapshot away. */
function normalize(file: string, content: string): string {
  if (file !== 'package.json') return content;
  try {
    const j = JSON.parse(content);
    return JSON.stringify(Object.fromEntries(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions', 'pnpm', 'packageManager', 'engines', 'workspaces', 'patchedDependencies'].filter((k) => j[k] !== undefined).map((k) => [k, j[k]])));
  } catch { return content; }
}

/**
 * The fingerprint of an environment: lock files and install settings, the `setup` command, the tool versions, and the identity of
 * the task image. Null when the project has no lock file (no snapshot is kept then).
 */
export function fingerprint(o: { files: Record<string, string | null>; setup: string; runtime: string; image: string }): string | null {
  const present = LOCK_FILES.filter((f) => o.files[f] != null);
  if (!present.some((f) => LOCKS.has(f))) return null;
  const h = createHash('sha256');
  h.update(JSON.stringify({ v: 1, setup: o.setup, runtime: o.runtime, image: o.image, files: present.map((f) => [f, createHash('sha256').update(normalize(f, o.files[f]!)).digest('hex')]) }));
  return h.digest('hex');
}

const SECRET = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\..*)?|\.npmrc|\.netrc|\.pypirc|.*\.log)\/?$/i;
/** Ignored paths worth keeping: never anything that looks like a secret (an `.env` file is git-ignored on purpose) or a log. */
export const snapshotPaths = (ignored: string[]): string[] => ignored.filter((p) => p && !p.startsWith('.bivouac') && !SECRET.test(p));

export const isFingerprint = (fp: string) => /^[0-9a-f]{64}$/.test(fp);
export const snapshotFile = (dir: string, fp: string) => {
  if (!isFingerprint(fp)) throw new Error('bad snapshot fingerprint');
  return path.join(dir, `${fp}.tar`);
};

function run(cmd: string, args: string[], o: { stdin?: string; cwd?: string } = {}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: o.cwd, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (b) => { if (stderr.length < 4000) stderr += b; });
    p.on('error', (e) => resolve({ code: 127, stderr: String(e) }));
    p.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    p.stdin.on('error', () => {});
    p.stdin.end(o.stdin ?? '');
  });
}

/** Writes the archive of `paths` (relative to `repo`) to `<dir>/<fp>.tar`, atomically. Returns its size, or null when it is too large. */
export async function createArchive(dir: string, fp: string, repo: string, paths: string[], maxBytes = SNAPSHOT_MAX_BYTES): Promise<{ bytes: number } | { tooLarge: number } | null> {
  if (!paths.length) return null;
  mkdirSync(dir, { recursive: true });
  const file = snapshotFile(dir, fp), tmp = `${file}.tmp-${process.pid}`;
  const r = await run('tar', ['-C', repo, '--null', '--files-from=-', '-cf', tmp], { stdin: paths.join('\0') });
  if (r.code !== 0 && r.code !== 1) { rmSync(tmp, { force: true }); throw new Error(`tar failed: ${r.stderr.trim()}`); } // 1 = a file changed while being read
  const bytes = statSync(tmp).size;
  if (bytes > maxBytes) { rmSync(tmp, { force: true }); return { tooLarge: bytes }; }
  renameSync(tmp, file);
  return { bytes };
}
export async function extractArchive(dir: string, fp: string, repo: string): Promise<boolean> {
  const file = snapshotFile(dir, fp);
  if (!existsSync(file)) return false;
  return (await run('tar', ['-xf', file, '-C', repo])).code === 0;
}
export function removeArchive(dir: string, fp: string) { rmSync(snapshotFile(dir, fp), { force: true }); }
