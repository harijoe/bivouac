import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

export interface DaemonConfig {
  dataDir: string;
  /** Public listener (dashboard, API, MCP, OAuth). Reached through Traefik only. */
  port: number;
  /** Internal listener (Traefik provider + forwardAuth). Never published. */
  internalPort: number;
  bind: string;
  /** Prefix for every docker resource we create (containers, networks). */
  namePrefix: string;
  taskImage: string;
  claudeBin: string;
  /** Public host of the dashboard; also the base domain of previews (`<task>.<project>.<domain>`). */
  domain: string;
  previewScheme: 'http' | 'https';
  /** Port Traefik is reachable on (appended to URLs when not 80/443). */
  previewPort: number;
  traefikContainer: string;
  /** Docker name of the web service, as reachable from Traefik. */
  webHost: string;
  certResolver: string | null;
  maxParallel: number;
  taskUid: number;
  dashboardDir: string | null;
  secretKey: Buffer;
  /** Where the executor lives (web only) and the shared secret between the two services. */
  executorUrl: string | null;
  executorToken: string;
  /** Static fallbacks (tests, advanced installs). The dashboard stores the real credentials. */
  oauthToken: string | null;
  apiKey: string | null;
  /** Redirect URI allow-list for MCP clients (`*` wildcards allowed in host and path). */
  oauthRedirectAllow: string[];
  /** Skips real GitHub calls: tests only. */
  testMode: boolean;
  /** Installed version, and where new releases are announced (GitHub releases API format). */
  version: string;
  releasesUrl: string;
  /** Image of this very daemon (the updater derives the registry from it) and the host directory holding apply.sh. */
  daemonImage: string;
  hostOptDir: string;
}

export const DEFAULT_REDIRECT_ALLOW = [
  'https://claude.ai/*', 'https://claude.com/*', 'https://*.claude.ai/*', 'https://chatgpt.com/*', 'https://*.chatgpt.com/*',
  'https://chat.openai.com/*', 'https://platform.openai.com/*',
  'http://localhost:*/*', 'http://127.0.0.1:*/*', 'http://[::1]:*/*',
];

function loadSecretKey(dataDir: string): Buffer {
  const p = path.join(dataDir, 'secret.key');
  if (existsSync(p)) return Buffer.from(readFileSync(p, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  writeFileSync(p, key.toString('hex') + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, o: { needSecretKey?: boolean } = {}): DaemonConfig {
  const dataDir = env.BIVOUAC_DATA_DIR ?? '/var/lib/bivouac';
  mkdirSync(dataDir, { recursive: true });
  const scheme = env.BIVOUAC_PREVIEW_SCHEME === 'http' ? 'http' : 'https';
  const extra = (env.BIVOUAC_OAUTH_REDIRECT_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    dataDir,
    port: Number(env.BIVOUAC_PORT ?? 3000),
    internalPort: Number(env.BIVOUAC_INTERNAL_PORT ?? 3001),
    bind: env.BIVOUAC_BIND ?? '0.0.0.0',
    namePrefix: env.BIVOUAC_NAME_PREFIX ?? 'bivouac',
    taskImage: env.BIVOUAC_TASK_IMAGE ?? 'bivouac-task:latest',
    claudeBin: env.BIVOUAC_CLAUDE_BIN ?? 'claude',
    domain: env.BIVOUAC_DOMAIN ?? 'localhost',
    previewScheme: scheme,
    previewPort: Number(env.BIVOUAC_PREVIEW_PORT ?? (scheme === 'https' ? 443 : 80)),
    traefikContainer: env.BIVOUAC_TRAEFIK_CONTAINER ?? 'bivouac-traefik',
    webHost: env.BIVOUAC_WEB_HOST ?? 'bivouac-web',
    certResolver: env.BIVOUAC_CERT_RESOLVER || null,
    maxParallel: Number(env.BIVOUAC_MAX_PARALLEL ?? 4),
    taskUid: Number(env.BIVOUAC_TASK_UID ?? 1000),
    dashboardDir: env.BIVOUAC_DASHBOARD_DIR ?? null,
    secretKey: o.needSecretKey === false ? Buffer.alloc(32) : loadSecretKey(dataDir),
    executorUrl: env.BIVOUAC_EXECUTOR_URL || null,
    executorToken: env.BIVOUAC_EXECUTOR_TOKEN ?? '',
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || null,
    apiKey: env.ANTHROPIC_API_KEY || null,
    oauthRedirectAllow: [...DEFAULT_REDIRECT_ALLOW, ...extra],
    testMode: env.BIVOUAC_TEST_MODE === '1',
    version: env.BIVOUAC_VERSION ?? 'dev',
    releasesUrl: env.BIVOUAC_RELEASES_URL || 'https://api.github.com/repos/harijoe/bivouac/releases?per_page=30',
    daemonImage: env.BIVOUAC_DAEMON_IMAGE ?? '',
    hostOptDir: env.BIVOUAC_HOST_OPT_DIR ?? '/opt/bivouac',
  };
}

/** Public base URL of the dashboard, e.g. `https://1-2-3-4.sslip.io`. */
export function baseUrl(cfg: Pick<DaemonConfig, 'domain' | 'previewScheme' | 'previewPort'>): string {
  const std = (cfg.previewScheme === 'http' && cfg.previewPort === 80) || (cfg.previewScheme === 'https' && cfg.previewPort === 443);
  return `${cfg.previewScheme}://${cfg.domain}${std ? '' : ':' + cfg.previewPort}`;
}
