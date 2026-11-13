import { SKILL_CATALOGUE, type ProjectConfig, type Project, type Tooling, type ToolingSkill } from '@bivouac/shared';
import type { Store } from './db.js';
import type { Sandbox } from './sandbox.js';
import { planMcp, redactValues } from './agent-tools.js';

export const CHROMIUM_PATH = '/usr/bin/chromium';

const lines = async (sb: Sandbox, script: string) => {
  let out = '';
  await sb.exec(['sh', '-c', script], { onData: (c, s) => { if (s === 'stdout') out += c; } }).catch(() => 1);
  return out.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(l));
};

export interface PreparedTooling {
  /** Arguments to add to the `claude` command line. */
  args: string[];
  /** Variables the arguments refer to. Their values are secrets. */
  env: Record<string, string>;
  /** Everything that must never appear in an event or a log. */
  secretValues: string[];
  tooling: Tooling;
  /** Things the agent should be told (a server or skill that was not given). */
  notes: string[];
}

/**
 * What the agent gets at the start of an attempt: the MCP servers (built-ins, minus the ones switched off, plus the project's own)
 * as a `--mcp-config` value, and the skills of the image, of the catalogue and of the repository. A server that asks for secrets
 * is only given them when an administrator approved that exact definition in the dashboard.
 */
export async function prepareTooling(d: { store: Store; project: Project; sb: Sandbox; eff: ProjectConfig; installSkills: boolean }): Promise<PreparedTooling> {
  const { store, project, sb, eff } = d;
  const secrets = store.getProjectSecretValues(project.id);
  const context7Key = store.getSecretSetting('context7_api_key');
  const plan = planMcp({
    mcp: eff.mcp, chromium: CHROMIUM_PATH, context7Key, secrets,
    isApproved: (n, fp) => store.isMcpApproved(project.id, n, fp),
    seen: (n, fp, spec) => store.noteMcpServer(project.id, n, fp, spec),
  });
  const notes = [...plan.warnings];

  const wanted = eff.skills ?? [];
  const catalogueDirs = new Set(Object.values(SKILL_CATALOGUE).map((e) => e.dir));
  const failed: Record<string, string> = {};
  if (d.installSkills && wanted.length) {
    for (const r of await sb.installSkills(wanted)) if (!r.ok) failed[r.name] = r.error ?? 'failed';
  }
  const keep = new Set(wanted.map((n) => SKILL_CATALOGUE[n]?.dir));
  const home = await lines(sb, 'ls -1 "$HOME/.claude/skills" 2>/dev/null');
  for (const dir of home) if (catalogueDirs.has(dir) && !keep.has(dir)) await sb.exec(['sh', '-c', 'rm -rf "$HOME/.claude/skills/$0"', dir]).catch(() => 1);
  const repoSkills = await lines(sb, 'ls -1 /workspace/repo/.claude/skills 2>/dev/null');
  const skills: ToolingSkill[] = [];
  for (const dir of home) {
    if (catalogueDirs.has(dir)) { if (keep.has(dir)) skills.push({ name: dir, source: 'catalogue' }); }
    else skills.push({ name: dir, source: 'image' });
  }
  for (const [name, err] of Object.entries(failed)) notes.push(`Skill "${name}" could not be installed (${err}).`);
  for (const n of wanted) if (failed[n] && !skills.some((s) => s.name === SKILL_CATALOGUE[n].dir)) skills.push({ name: SKILL_CATALOGUE[n].dir, source: 'catalogue', note: `not installed: ${failed[n]}` });
  for (const dir of repoSkills) if (!skills.some((s) => s.name === dir)) skills.push({ name: dir, source: 'repository' });

  const args = Object.keys(plan.config.mcpServers).length ? ['--mcp-config', JSON.stringify(plan.config)] : [];
  const secretValues = [...Object.values(secrets), ...(context7Key ? [context7Key] : [])];
  return { args, env: plan.env, secretValues, tooling: { mcp: plan.entries, skills }, notes };
}

export const redactData = (data: unknown, values: string[]): unknown => {
  if (!values.length) return data;
  const text = JSON.stringify(data);
  const clean = redactValues(text, values.map((v) => JSON.stringify(v).slice(1, -1)));
  return clean === text ? data : JSON.parse(clean);
};
