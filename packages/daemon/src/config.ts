import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

export interface DaemonConfig {
  dataDir: string;
  port: number;
  bind: string;
  accessToken: string;
  /** Prefix for every docker resource we create (containers, networks). */
  namePrefix: string;
  taskImage: string;
  claudeBin: string;
  /** Base domain for previews, e.g. `100-64-1-2.sslip.io` or `example.com`. */
  domain: string;
  previewScheme: 'http' | 'https';
  /** Port Traefik is reachable on (appended to preview URLs when not 80/443). */
  previewPort: number;
  traefikContainer: string;
  certResolver: string | null;
  maxParallel: number;
  taskUid: number;
  dashboardDir: string | null;
  secretKey: Buffer;
  oauthToken: string | null;
  apiKey: string | null;
}

function loadSecretKey(dataDir: string): Buffer {
  const p = path.join(dataDir, 'secret.key');
  if (existsSync(p)) return Buffer.from(readFileSync(p, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  writeFileSync(p, key.toString('hex') + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const dataDir = env.BIVOUAC_DATA_DIR ?? '/var/lib/bivouac';
  mkdirSync(dataDir, { recursive: true });
  const scheme = env.BIVOUAC_PREVIEW_SCHEME === 'https' ? 'https' : 'http';
  const accessToken = env.BIVOUAC_ACCESS_TOKEN ?? '';
  if (!accessToken) throw new Error('BIVOUAC_ACCESS_TOKEN is required');
  return {
    dataDir,
    port: Number(env.BIVOUAC_PORT ?? 3000),
    bind: env.BIVOUAC_BIND ?? '0.0.0.0',
    accessToken,
    namePrefix: env.BIVOUAC_NAME_PREFIX ?? 'bivouac',
    taskImage: env.BIVOUAC_TASK_IMAGE ?? 'bivouac-task:latest',
    claudeBin: env.BIVOUAC_CLAUDE_BIN ?? 'claude',
    domain: env.BIVOUAC_DOMAIN ?? 'localhost',
    previewScheme: scheme,
    previewPort: Number(env.BIVOUAC_PREVIEW_PORT ?? (scheme === 'https' ? 443 : 80)),
    traefikContainer: env.BIVOUAC_TRAEFIK_CONTAINER ?? 'bivouac-traefik',
    certResolver: env.BIVOUAC_CERT_RESOLVER || null,
    maxParallel: Number(env.BIVOUAC_MAX_PARALLEL ?? 4),
    taskUid: Number(env.BIVOUAC_TASK_UID ?? 1000),
    dashboardDir: env.BIVOUAC_DASHBOARD_DIR ?? null,
    secretKey: loadSecretKey(dataDir),
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || null,
    apiKey: env.ANTHROPIC_API_KEY || null,
  };
}
