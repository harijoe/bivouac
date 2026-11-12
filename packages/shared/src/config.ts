import { parse } from 'yaml';

/** A sidecar (database, cache…) started next to the task container, on the task's private network. */
export interface ServiceConfig {
  image: string;
  env?: Record<string, string>;
  /** Absolute path inside the service container, backed by a volume owned by the task. */
  volume?: string;
  cpus?: number;
  memory?: string;
}

/** Defaults of a sidecar service (a database under real load needs more than the 512 MB it used to get). */
export const DEFAULT_SERVICE_MEMORY = '1g';
export const DEFAULT_SERVICE_CPUS = 1;

export interface ProjectConfig {
  setup?: string;
  /** Tool versions forced for the task (`node: "26"`, `python: "3.12"`…); wins over what the repository declares. */
  runtime?: Record<string, string>;
  dev?: { command: string; port?: number };
  /** Named ports of the app, in order; the first one is the primary port (URL without a name prefix). */
  ports?: Record<string, number>;
  services?: Record<string, ServiceConfig>;
  success?: string;
  limits?: { cpus?: number; memory?: string };
  /** How bivouac watches and photographs the preview. */
  preview?: { health?: { port?: number; path?: string }; screenshots?: string[] };
  budget?: { max_iterations?: number; max_cost_usd?: number; max_tokens?: number };
}

export const MAX_PORTS = 6;
export const MAX_SCREENSHOT_PAGES = 6;
export const DEFAULT_SCREENSHOT_PAGES = ['/'];
export const MAX_SERVICES = 5;
export const RESERVED_SERVICE_NAMES = ['task', 'localhost', 'traefik', 'web', 'executor'];
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,150}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
function validateLabel(v: string, what: string): string | null {
  return LABEL_RE.test(v) ? null : `${what} "${v}" is invalid: use lowercase letters, digits and dashes (1 to 30 characters)`;
}

export interface PortDef { name: string; port: number; primary: boolean }
/** The ports a task exposes. `ports` wins over the legacy `dev.port`, which is a single port named "web". */
export function resolvePorts(cfg: ProjectConfig): PortDef[] {
  if (cfg.ports && Object.keys(cfg.ports).length) return Object.entries(cfg.ports).map(([name, port], i) => ({ name, port, primary: i === 0 }));
  return cfg.dev?.port ? [{ name: 'web', port: cfg.dev.port, primary: true }] : [];
}

export const DEFAULT_CONFIG: Required<Pick<ProjectConfig, 'success'>> & ProjectConfig = {
  success: 'true',
  dev: { command: 'pnpm dev --host 0.0.0.0', port: 5173 },
  limits: { cpus: 2, memory: '4g' },
  budget: { max_iterations: 10, max_cost_usd: 20 },
};

/** Validates the `services` section (also used by the executor, which does not trust its caller). */
export function parseServices(sv: unknown): Record<string, ServiceConfig> {
  const num = (k: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${k} must be a positive number`);
    return v;
  };
  if (typeof sv !== 'object' || !sv || Array.isArray(sv)) throw new Error('services must be a mapping of name to service');
  const entries = Object.entries(sv) as [string, any][];
  if (entries.length > MAX_SERVICES) throw new Error(`services: at most ${MAX_SERVICES} services`);
  const out: Record<string, ServiceConfig> = {};
  for (const [name, s] of entries) {
    const err = validateLabel(name, 'service name');
    if (err) throw new Error(err);
    if (RESERVED_SERVICE_NAMES.includes(name)) throw new Error(`service name "${name}" is reserved`);
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`services.${name} must be a mapping`);
    if (typeof s.image !== 'string' || !IMAGE_RE.test(s.image)) throw new Error(`services.${name}.image must be an image reference such as postgres:16`);
    const svc: ServiceConfig = { image: s.image };
    if (s.env !== undefined) {
      if (typeof s.env !== 'object' || !s.env || Array.isArray(s.env)) throw new Error(`services.${name}.env must be a mapping`);
      svc.env = {};
      for (const [k, v] of Object.entries(s.env)) {
        if (!ENV_KEY_RE.test(k)) throw new Error(`services.${name}.env: invalid variable name "${k}"`);
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error(`services.${name}.env.${k} must be a string`);
        svc.env[k] = String(v);
      }
    }
    if (s.volume !== undefined) {
      if (typeof s.volume !== 'string' || !/^\/[A-Za-z0-9_./-]{1,200}$/.test(s.volume) || s.volume.split('/').includes('..')) throw new Error(`services.${name}.volume must be an absolute path inside the service, for example /var/lib/postgresql/data`);
      svc.volume = s.volume;
    }
    if (s.cpus !== undefined) svc.cpus = num(`services.${name}.cpus`, s.cpus);
    if (s.memory !== undefined) {
      svc.memory = String(s.memory);
      if (!/^\d+(\.\d+)?[kmgKMG]?$/.test(svc.memory)) throw new Error(`services.${name}.memory must look like 512m or 1g`);
    }
    out[name] = svc;
  }
  return out;
}

export const MAX_RUNTIME_TOOLS = 8;
const TOOL_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const TOOL_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
/** `runtime:` section: tool name -> version (a YAML number such as 26 or 3.12 is accepted; quote "3.10" to keep the zero). */
export function parseRuntime(rt: unknown): Record<string, string> {
  if (typeof rt !== 'object' || !rt || Array.isArray(rt)) throw new Error('runtime must be a mapping of tool to version, for example { node: "26", python: "3.12" }');
  const entries = Object.entries(rt);
  if (entries.length > MAX_RUNTIME_TOOLS) throw new Error(`runtime: at most ${MAX_RUNTIME_TOOLS} tools`);
  const out: Record<string, string> = {};
  for (const [tool, v] of entries) {
    if (!TOOL_RE.test(tool)) throw new Error(`runtime: invalid tool name "${tool}"`);
    if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`runtime.${tool} must be a version such as "26"`);
    const ver = String(v);
    if (!TOOL_VERSION_RE.test(ver)) throw new Error(`runtime.${tool}: invalid version "${ver}"`);
    out[tool] = ver;
  }
  return out;
}

const URL_PATH_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]{0,300}$/;
/** `preview:` section: where the dev server answers its health check and which pages are photographed after each attempt. */
export function parsePreview(pv: unknown): NonNullable<ProjectConfig['preview']> {
  if (typeof pv !== 'object' || !pv || Array.isArray(pv)) throw new Error('preview must be a mapping, for example { health: { path: "/health" }, screenshots: ["/", "/login"] }');
  const raw = pv as Record<string, any>;
  const out: NonNullable<ProjectConfig['preview']> = {};
  if (raw.health !== undefined) {
    const h = raw.health;
    if (typeof h !== 'object' || !h || Array.isArray(h)) throw new Error('preview.health must be a mapping with an optional port and path');
    out.health = {};
    if (h.port !== undefined) {
      if (typeof h.port !== 'number' || !Number.isInteger(h.port) || h.port < 1 || h.port > 65535) throw new Error('preview.health.port must be a port number between 1 and 65535');
      out.health.port = h.port;
    }
    if (h.path !== undefined) {
      if (typeof h.path !== 'string' || !URL_PATH_RE.test(h.path)) throw new Error('preview.health.path must be a path starting with /, for example /health');
      out.health.path = h.path;
    }
  }
  if (raw.screenshots !== undefined) {
    const s = raw.screenshots;
    if (!Array.isArray(s) || s.length > MAX_SCREENSHOT_PAGES) throw new Error(`preview.screenshots must be a list of at most ${MAX_SCREENSHOT_PAGES} paths, for example ["/", "/login"]`);
    for (const p of s) if (typeof p !== 'string' || !URL_PATH_RE.test(p)) throw new Error(`preview.screenshots: "${String(p)}" is not a path starting with /`);
    out.screenshots = s as string[];
  }
  return out;
}

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
  if (raw.image !== undefined) throw new Error('`image` is no longer supported: the task image cannot be replaced. Choose tool versions with `runtime:` (for example `runtime: { node: "26" }`) and install the rest in `setup:`.');
  if (raw.runtime !== undefined) cfg.runtime = parseRuntime(raw.runtime);
  if (raw.setup !== undefined) cfg.setup = str('setup', raw.setup);
  if (raw.success !== undefined) cfg.success = str('success', raw.success);
  if (raw.ports !== undefined) {
    const p = raw.ports;
    if (typeof p !== 'object' || !p || Array.isArray(p)) throw new Error('ports must be a mapping of name to port, for example { web: 5173, api: 3000 }');
    const entries = Object.entries(p);
    if (entries.length > MAX_PORTS) throw new Error(`ports: at most ${MAX_PORTS} ports`);
    cfg.ports = {};
    const seen = new Set<number>();
    for (const [name, v] of entries) {
      const err = validateLabel(name, 'port name');
      if (err) throw new Error(err);
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`ports.${name} must be a port number between 1 and 65535`);
      if (seen.has(v)) throw new Error(`ports.${name}: port ${v} is declared twice`);
      seen.add(v);
      cfg.ports[name] = v;
    }
  }
  if (raw.dev !== undefined) {
    const d = raw.dev;
    if (typeof d !== 'object' || !d) throw new Error('dev must be a mapping');
    const command = str('dev.command', d.command);
    const port = d.port === undefined ? undefined : num('dev.port', d.port);
    if (!command) throw new Error('dev.command is required');
    if (!port && !cfg.ports) throw new Error('dev.port is required (or declare ports: { web: 5173 })');
    cfg.dev = port ? { command, port } : { command };
  }
  if (raw.services !== undefined) cfg.services = parseServices(raw.services);
  if (raw.preview !== undefined) cfg.preview = parsePreview(raw.preview);
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

/** Semantic versions: `1.2.3`, optionally `v`-prefixed and with a `-pre` suffix. */
export interface SemVer { major: number; minor: number; patch: number; pre: string | null }
export function parseSemver(v: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null } : null;
}
/** <0 when a is older than b. A pre-release is older than its release. Returns NaN when either is not a version. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return NaN;
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** A short plain-text title from the first line of a prompt: Markdown syntax (headings, emphasis, links, code) removed. */
export function titleFromPrompt(prompt: string, max = 80): string {
  const first = prompt.split('\n').map((l) => l.trim()).find((l) => l && !/^(```|~~~|---+|===+|\*\*\*+)$/.test(l)) ?? '';
  const t = first
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`|\*|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9]))/g, '')
    .replace(/\s+/g, ' ').trim();
  return t.slice(0, max).trim() || 'Untitled task';
}
