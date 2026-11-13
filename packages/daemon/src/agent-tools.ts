import { createHash } from 'node:crypto';
import type { McpConfig, McpServerConfig, ToolingMcp } from '@bivouac/shared';

export const SECRET_ENV_PREFIX = 'BIVOUAC_MCP_SECRET_';
export const CONTEXT7_ENV = 'BIVOUAC_CONTEXT7_API_KEY';
export const PLAYWRIGHT_MCP_CLI = '/opt/bivouac/mcp/node_modules/@playwright/mcp/cli.js';
export const CONTEXT7_MCP_CLI = '/opt/bivouac/mcp/node_modules/@upstash/context7-mcp/dist/index.js';

export interface McpPlanInput {
  mcp: McpConfig | undefined;
  chromium: string;
  context7Key: string | null;
  secrets: Record<string, string>;
  isApproved: (name: string, fingerprint: string) => boolean;
  seen?: (name: string, fingerprint: string, spec: McpServerConfig) => void;
}
export interface McpPlan {
  config: { mcpServers: Record<string, unknown> };
  env: Record<string, string>;
  entries: ToolingMcp[];
  warnings: string[];
}

export const fingerprintServer = (name: string, s: McpServerConfig) => createHash('sha256').update(JSON.stringify({ name, s })).digest('hex').slice(0, 32);
const ref = (secret: string) => '${' + SECRET_ENV_PREFIX + secret + '}';
const withRefs = (v: string) => v.replace(/\$\{([^}]*)\}/g, (_m, n) => ref(n));

export function planMcp(i: McpPlanInput): McpPlan {
  const servers: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const entries: ToolingMcp[] = [];
  const warnings: string[] = [];
  if (i.mcp?.playwright !== false) {
    servers.playwright = { type: 'stdio', command: 'node', args: [PLAYWRIGHT_MCP_CLI, '--headless', '--browser', 'chromium', '--executable-path', i.chromium, '--no-sandbox', '--isolated', '--output-dir', '/tmp/playwright-mcp'] };
    entries.push({ name: 'playwright', kind: 'builtin', transport: 'stdio', status: 'configured' });
  }
  if (i.mcp?.context7 !== false) {
    const e: Record<string, string> = {};
    if (i.context7Key) { e.CONTEXT7_API_KEY = '${' + CONTEXT7_ENV + '}'; env[CONTEXT7_ENV] = i.context7Key; }
    servers.context7 = { type: 'stdio', command: 'node', args: [CONTEXT7_MCP_CLI], ...(Object.keys(e).length ? { env: e } : {}) };
    entries.push({ name: 'context7', kind: 'builtin', transport: 'stdio', status: 'configured' });
  }
  for (const [name, s] of Object.entries(i.mcp?.servers ?? {})) {
    const transport = s.url ? 'http' : 'stdio';
    const skip = (note: string) => { entries.push({ name, kind: 'project', transport, status: 'skipped', note }); warnings.push(`MCP server "${name}" was not given to the agent: ${note}`); };
    const needs = s.secrets ?? [];
    if (needs.length) {
      const fp = fingerprintServer(name, s);
      i.seen?.(name, fp, s);
      if (!i.isApproved(name, fp)) { skip('it asks for secrets and an administrator has not approved this definition yet (project settings in the dashboard)'); continue; }
      const missing = needs.filter((n) => !(n in i.secrets));
      if (missing.length) { skip(`secret${missing.length > 1 ? 's' : ''} ${missing.join(', ')} not set in the project settings`); continue; }
    }
    for (const n of needs) env[SECRET_ENV_PREFIX + n] = i.secrets[n];
    if (s.url) {
      servers[name] = { type: 'http', url: withRefs(s.url), ...(s.headers ? { headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, withRefs(v)])) } : {}) };
    } else {
      const e: Record<string, string> = { ...Object.fromEntries(needs.map((n) => [n, ref(n)])), ...Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, withRefs(v)])) };
      servers[name] = { type: 'stdio', command: withRefs(s.command!), ...(s.args ? { args: s.args.map(withRefs) } : {}), ...(Object.keys(e).length ? { env: e } : {}) };
    }
    entries.push({ name, kind: 'project', transport, status: 'configured' });
  }
  return { config: { mcpServers: servers }, env, entries, warnings };
}

/** Replaces every occurrence of a secret value (6 characters or more) with a marker. */
export function redactValues(text: string, values: Iterable<string>): string {
  let out = text;
  for (const v of values) if (v.length >= 6) out = out.split(v).join('[redacted]');
  return out;
}

/** Removes the `hooks:` block from the YAML front matter of a SKILL.md (a skill's hooks run commands outside bivouac's limits). */
export function stripSkillHooks(md: string): { text: string; removed: boolean } {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(md);
  if (!m) return { text: md, removed: false };
  const out: string[] = [];
  let skipping = false, removed = false;
  for (const l of m[2].split(/\r?\n/)) {
    if (/^hooks\s*:/.test(l)) { skipping = true; removed = true; continue; }
    if (skipping && (/^\s/.test(l) || l === '')) continue;
    skipping = false;
    out.push(l);
  }
  return removed ? { text: m[1] + out.join('\n') + md.slice(m[0].length - m[3].length), removed } : { text: md, removed: false };
}
