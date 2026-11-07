import { parse } from 'yaml';

export interface ProjectConfig {
  image?: string;
  setup?: string;
  dev?: { command: string; port: number };
  success?: string;
  limits?: { cpus?: number; memory?: string };
  budget?: { max_iterations?: number; max_cost_usd?: number; max_tokens?: number };
}

export const DEFAULT_CONFIG: Required<Pick<ProjectConfig, 'success'>> & ProjectConfig = {
  success: 'true',
  dev: { command: 'pnpm dev --host 0.0.0.0', port: 5173 },
  limits: { cpus: 2, memory: '4g' },
  budget: { max_iterations: 10, max_cost_usd: 20 },
};

/** Parse and validate a bivouac.yml document. Throws on invalid input. */
export function parseProjectConfig(text: string): ProjectConfig {
  const raw = parse(text) ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bivouac.yml must be a mapping');
  const str = (k: string, v: unknown) => {
    if (v !== undefined && typeof v !== 'string') throw new Error(`${k} must be a string`);
    return v as string | undefined;
  };
  const num = (k: string, v: unknown) => {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) throw new Error(`${k} must be a positive number`);
    return v as number | undefined;
  };
  const cfg: ProjectConfig = {};
  if (raw.image !== undefined) cfg.image = str('image', raw.image);
  if (raw.setup !== undefined) cfg.setup = str('setup', raw.setup);
  if (raw.success !== undefined) cfg.success = str('success', raw.success);
  if (raw.dev !== undefined) {
    const d = raw.dev;
    if (typeof d !== 'object' || !d) throw new Error('dev must be a mapping');
    const command = str('dev.command', d.command);
    const port = num('dev.port', d.port);
    if (!command || !port) throw new Error('dev.command and dev.port are required');
    cfg.dev = { command, port };
  }
  if (raw.limits !== undefined) {
    cfg.limits = { cpus: num('limits.cpus', raw.limits.cpus), memory: raw.limits.memory === undefined ? undefined : String(raw.limits.memory) };
    if (cfg.limits.memory && !/^\d+(\.\d+)?[kmgKMG]?$/.test(cfg.limits.memory)) throw new Error('limits.memory must look like 512m or 4g');
  }
  if (raw.budget !== undefined) {
    cfg.budget = {
      max_iterations: num('budget.max_iterations', raw.budget.max_iterations),
      max_cost_usd: num('budget.max_cost_usd', raw.budget.max_cost_usd),
      max_tokens: num('budget.max_tokens', raw.budget.max_tokens),
    };
  }
  return cfg;
}

/** Merge: defaults < repo file < dashboard override. */
export function mergeConfig(...layers: (ProjectConfig | undefined)[]): ProjectConfig {
  const out: any = {};
  for (const l of [DEFAULT_CONFIG, ...layers]) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) {
      if (v === undefined) continue;
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(out[k] ?? {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) } : v;
    }
  }
  return out;
}

export function slugify(s: string, max = 30): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'x';
}

/** Task names are DNS labels used in preview hostnames: lowercase letters, digits and dashes, 1 to 40 chars. */
export const TASK_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export function validateTaskName(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return 'Task name is required. Use lowercase letters, digits and dashes (1 to 40 characters), for example "login-page".';
  if (!TASK_NAME_RE.test(name)) return `"${name}" is not a valid task name. Use only lowercase letters, digits and dashes (1 to 40 characters, not starting or ending with a dash), for example "login-page".`;
  return null;
}
