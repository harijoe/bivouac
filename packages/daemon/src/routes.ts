import type { DaemonConfig } from './config.js';

type HostCfg = Pick<DaemonConfig, 'domain' | 'previewScheme' | 'previewPort'>;

export function previewHost(cfg: Pick<DaemonConfig, 'domain'>, project: string, taskName: string): string {
  return `${taskName}.${project}.${cfg.domain}`;
}

const portSuffix = (cfg: HostCfg) =>
  (cfg.previewScheme === 'http' && cfg.previewPort === 80) || (cfg.previewScheme === 'https' && cfg.previewPort === 443) ? '' : ':' + cfg.previewPort;

export function previewUrl(cfg: HostCfg, project: string, taskName: string): string {
  return `${cfg.previewScheme}://${previewHost(cfg, project, taskName)}${portSuffix(cfg)}`;
}

/** What the web service needs to know about a task to publish its route. */
export interface RouteTask { id: number; name: string; project: string; devPort: number | null }

/**
 * Traefik v3 dynamic configuration served over the HTTP provider.
 * Task routes are protected by a forwardAuth middleware that calls the web service on its internal port.
 */
export function buildTraefikConfig(cfg: Pick<DaemonConfig, 'domain' | 'previewScheme' | 'certResolver' | 'webHost' | 'namePrefix' | 'port' | 'internalPort'>, tasks: RouteTask[]) {
  const https = cfg.previewScheme === 'https';
  const entry = https ? 'websecure' : 'web';
  const tls = https ? (cfg.certResolver ? { certResolver: cfg.certResolver } : {}) : undefined;
  const routers: Record<string, any> = {
    'bivouac-web': { rule: `Host(\`${cfg.domain}\`)`, entryPoints: [entry], service: 'bivouac-web', ...(tls ? { tls } : {}) },
  };
  const services: Record<string, any> = {
    'bivouac-web': { loadBalancer: { servers: [{ url: `http://${cfg.webHost}:${cfg.port}` }] } },
  };
  for (const t of tasks) {
    if (!t.devPort) continue;
    const key = `bivouac-t${t.id}`;
    routers[key] = {
      rule: `Host(\`${previewHost(cfg, t.project, t.name)}\`)`, entryPoints: [entry], service: key, middlewares: ['bivouac-preview-auth'],
      ...(tls ? { tls } : {}),
    };
    services[key] = { loadBalancer: { passHostHeader: true, servers: [{ url: `http://${cfg.namePrefix}-task-${t.id}:${t.devPort}` }] } };
  }
  return {
    http: {
      routers,
      services,
      middlewares: {
        'bivouac-preview-auth': {
          forwardAuth: {
            address: `http://${cfg.webHost}:${cfg.internalPort}/internal/preview-auth`,
            trustForwardHeader: true,
            authResponseHeaders: ['Cookie'],
          },
        },
      },
    },
  };
}
