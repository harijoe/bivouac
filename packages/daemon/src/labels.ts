import type { DaemonConfig } from './config.js';

export interface PreviewSpec {
  taskId: number;
  project: string;
  port: number;
  network: string;
  publicAuth?: { user: string; htpasswdHash: string } | null;
}

export function previewHost(cfg: Pick<DaemonConfig, 'domain'>, project: string, taskId: number): string {
  return `t-${taskId}.${project}.${cfg.domain}`;
}

export function previewUrl(cfg: Pick<DaemonConfig, 'domain' | 'previewScheme' | 'previewPort'>, project: string, taskId: number): string {
  const std = (cfg.previewScheme === 'http' && cfg.previewPort === 80) || (cfg.previewScheme === 'https' && cfg.previewPort === 443);
  return `${cfg.previewScheme}://${previewHost(cfg, project, taskId)}${std ? '' : ':' + cfg.previewPort}`;
}

/** Traefik v3 docker-provider labels for a task container. */
export function traefikLabels(cfg: Pick<DaemonConfig, 'domain' | 'previewScheme' | 'certResolver'>, p: PreviewSpec): Record<string, string> {
  const name = `bivouac-t${p.taskId}`;
  const https = cfg.previewScheme === 'https';
  const l: Record<string, string> = {
    'traefik.enable': 'true',
    'traefik.docker.network': p.network,
    [`traefik.http.routers.${name}.rule`]: `Host(\`${previewHost(cfg, p.project, p.taskId)}\`)`,
    [`traefik.http.routers.${name}.entrypoints`]: https ? 'websecure' : 'web',
    [`traefik.http.routers.${name}.service`]: name,
    [`traefik.http.services.${name}.loadbalancer.server.port`]: String(p.port),
  };
  if (https && cfg.certResolver) {
    l[`traefik.http.routers.${name}.tls`] = 'true';
    l[`traefik.http.routers.${name}.tls.certresolver`] = cfg.certResolver;
  } else if (https) {
    l[`traefik.http.routers.${name}.tls`] = 'true';
  }
  if (p.publicAuth) {
    l[`traefik.http.middlewares.${name}-auth.basicauth.users`] = `${p.publicAuth.user}:${p.publicAuth.htpasswdHash.replace(/\$/g, '$$$$')}`;
    l[`traefik.http.routers.${name}.middlewares`] = `${name}-auth`;
  }
  return l;
}
