/**
 * Tool versions of a task: what the repository declares (and `runtime:` in bivouac.yml, which wins) is turned into one
 * mise configuration. The task image only ships mise; the tools are installed without root into a per-project cache.
 */
import { parse as parseToml } from 'smol-toml';
import { minVersion, validRange } from 'semver';

/** Files read from the repository root to find the versions it wants. */
export const RUNTIME_FILES = ['mise.toml', '.mise.toml', '.tool-versions', '.nvmrc', '.node-version', 'package.json', '.python-version', 'go.mod', 'rust-toolchain.toml', 'rust-toolchain'] as const;

export type RuntimeFiles = Partial<Record<(typeof RUNTIME_FILES)[number], string | null>>;
export interface RuntimeSpec { tools: Record<string, string>; sources: Record<string, string> }

const TOOL_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
/** Names used by other version managers, mapped to mise's. */
const ALIASES: Record<string, string> = { nodejs: 'node', golang: 'go', pnpm: 'pnpm' };
const toolName = (n: string) => ALIASES[n.toLowerCase()] ?? n.toLowerCase();

/** `v20.1.0` -> `20.1.0`; `lts/*` -> `lts`; other aliases (`lts/iron`, `system`, paths…) are not versions we can install. */
function cleanVersion(v: string): string | null {
  let x = v.trim().replace(/^v(?=\d)/, '');
  if (/^lts\/\*$|^lts$/i.test(x)) x = 'lts';
  if (x === 'node' || x === 'latest' || x === 'stable') x = 'latest';
  return VERSION_RE.test(x) && !/^(system|path|ref|prefix)/.test(x) ? x : null;
}

function fromPackageJson(text: string, add: (t: string, v: string | null, src: string) => void) {
  let pkg: any;
  try { pkg = JSON.parse(text); } catch { return; }
  const range = pkg?.engines?.node;
  if (typeof range === 'string' && validRange(range)) {
    const min = minVersion(range);
    // the lowest version the range allows, as a prefix mise understands (a range cannot be installed as such)
    if (min) add('node', min.minor || min.patch ? `${min.major}.${min.minor}` : String(min.major), 'package.json engines.node');
  }
  const pm = pkg?.packageManager;
  if (typeof pm === 'string') {
    const m = /^(pnpm|yarn|bun)@(\d+(?:\.\d+){0,2})/.exec(pm);
    if (m) add(m[1], m[2], 'package.json packageManager');
  }
}

function fromGoMod(text: string, add: (t: string, v: string | null, src: string) => void) {
  const tc = /^toolchain\s+go(\d+\.\d+(?:\.\d+)?)/m.exec(text);
  const g = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(text);
  add('go', tc?.[1] ?? g?.[1] ?? null, 'go.mod');
}

function fromToolVersions(text: string, add: (t: string, v: string | null, src: string) => void) {
  for (const line of text.split('\n')) {
    const [name, ver] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (name && ver) add(toolName(name), cleanVersion(ver), '.tool-versions');
  }
}

function fromMiseToml(text: string, src: string, add: (t: string, v: string | null, src: string) => void) {
  let doc: any;
  try { doc = parseToml(text); } catch { return; }
  for (const [name, v] of Object.entries(doc?.tools ?? {})) {
    const first = Array.isArray(v) ? v[0] : v;
    const ver = typeof first === 'object' && first ? (first as any).version : first;
    if (typeof ver === 'string' || typeof ver === 'number') add(toolName(name), cleanVersion(String(ver)), src);
  }
}

function fromRustToolchain(text: string, src: string, add: (t: string, v: string | null, src: string) => void) {
  let channel: string | undefined;
  if (src.endsWith('.toml')) { try { channel = (parseToml(text) as any)?.toolchain?.channel; } catch { /* invalid file */ } }
  else channel = text.trim().split('\n')[0];
  if (typeof channel === 'string' && /^(\d+\.\d+(\.\d+)?|stable|beta|nightly)$/.test(channel.trim())) add('rust', channel.trim(), src);
}

/**
 * Merges every source, from the weakest to the strongest: package.json, go.mod, rust-toolchain, .python-version,
 * .nvmrc / .node-version, .tool-versions, mise.toml, then `runtime:` of bivouac.yml.
 */
export function detectRuntime(files: RuntimeFiles, override: Record<string, string> = {}): RuntimeSpec {
  const tools: Record<string, string> = {}; const sources: Record<string, string> = {};
  const add = (t: string, v: string | null, src: string) => {
    if (!v || !TOOL_RE.test(t)) return;
    tools[t] = v; sources[t] = src;
  };
  if (files['package.json']) fromPackageJson(files['package.json'], add);
  if (files['go.mod']) fromGoMod(files['go.mod'], add);
  if (files['rust-toolchain']) fromRustToolchain(files['rust-toolchain'], 'rust-toolchain', add);
  if (files['rust-toolchain.toml']) fromRustToolchain(files['rust-toolchain.toml'], 'rust-toolchain.toml', add);
  if (files['.python-version']) add('python', cleanVersion(files['.python-version'].trim().split('\n')[0]), '.python-version');
  if (files['.nvmrc']) add('node', cleanVersion(files['.nvmrc'].trim().split('\n')[0]), '.nvmrc');
  if (files['.node-version']) add('node', cleanVersion(files['.node-version'].trim().split('\n')[0]), '.node-version');
  if (files['.tool-versions']) fromToolVersions(files['.tool-versions'], add);
  if (files['.mise.toml']) fromMiseToml(files['.mise.toml'], '.mise.toml', add);
  if (files['mise.toml']) fromMiseToml(files['mise.toml'], 'mise.toml', add);
  for (const [t, v] of Object.entries(override)) add(t, VERSION_RE.test(v) ? v : null, 'bivouac.yml runtime');
  return { tools, sources };
}

/** The mise configuration for a spec. Names and versions were validated above, so nothing can be injected into the file. */
export function miseConfig(spec: RuntimeSpec): string {
  return ['[tools]', ...Object.entries(spec.tools).map(([t, v]) => `${t} = "${v}"`)].join('\n') + '\n';
}
export const runtimeKey = (spec: RuntimeSpec) => JSON.stringify(Object.entries(spec.tools).sort());
export const describeRuntime = (spec: RuntimeSpec) => Object.entries(spec.tools).map(([t, v]) => `${t} ${v}`).join(', ');

