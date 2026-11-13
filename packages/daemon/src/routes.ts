import type { PortDef } from '@bivouac/shared';
import type { DaemonConfig } from './config.js';

type HostCfg = Pick<DaemonConfig, 'domain' | 'previewScheme' | 'previewPort'>;

/** `<task>.<project>.<domain>` for the primary port, `<port>.<task>.<project>.<domain>` for the others. */
export function previewHost(cfg: Pick<DaemonConfig, 'domain'>, project: string, taskName: string, portName?: string): string {
  return `${portName ? portName + '.' : ''}${taskName}.${project}.${cfg.domain}`;
}

const portSuffix = (cfg: HostCfg) =>
  (cfg.previewScheme === 'http' && cfg.previewPort === 80) || (cfg.previewScheme === 'https' && cfg.previewPort === 443) ? '' : ':' + cfg.previewPort;

/** `<alias>.<domain>` for the primary port, `<port>.<alias>.<domain>` for the others. */
export function aliasHost(cfg: Pick<DaemonConfig, 'domain'>, alias: string, portName?: string): string {
  return `${portName ? portName + '.' : ''}${alias}.${cfg.domain}`;
}
export function aliasUrl(cfg: HostCfg & Pick<DaemonConfig, 'domain'>, alias: string, portName?: string): string {
  return `${cfg.previewScheme}://${aliasHost(cfg, alias, portName)}${portSuffix(cfg)}`;
}

export function previewUrl(cfg: HostCfg & Pick<DaemonConfig, 'domain'>, project: string, taskName: string, portName?: string): string {
  return `${cfg.previewScheme}://${previewHost(cfg, project, taskName, portName)}${portSuffix(cfg)}`;
}

/** What the web service needs to know about a task to publish its route. */
export interface RouteTask { id: number; name: string; project: string; ports: PortDef[]; /** Alias label of the project when it points at this task. */ alias?: string }

/**
 * Traefik v3 dynamic configuration served over the HTTP provider.
 * Task routes are protected by a forwardAuth middleware that calls the web service on its internal port.
 */
export function buildTraefikConfig(cfg: Pick<DaemonConfig, 'domain' | 'previewScheme' | 'certResolver' | 'webHost' | 'namePrefix' | 'port' | 'internalPort'>, tasks: RouteTask[]) {
  const https = cfg.previewScheme === 'https';
  const entry = https ? 'websecure' : 'web';
  const tls = https ? (cfg.certResolver ? { certResolver: cfg.certResolver } : {}) : undefined;
  const routers: Record<string, any> = {
    'bivouac-web': { rule: `Host(\`${cfg.domain}\`)`, entryPoints: [entry], service: 'bivouac-web', middlewares: ['bivouac-restarting'], ...(tls ? { tls } : {}) },
  };
  const services: Record<string, any> = {
    'bivouac-web': { loadBalancer: { servers: [{ url: `http://${cfg.webHost}:${cfg.port}` }] } },
    'bivouac-pages': { loadBalancer: { servers: [{ url: 'http://bivouac-pages:8080' }] } },
  };
  for (const t of tasks) {
    for (const p of t.ports) {
      const key = p.primary ? `bivouac-t${t.id}` : `bivouac-t${t.id}-${p.name}`;
      routers[key] = {
        rule: `Host(\`${previewHost(cfg, t.project, t.name, p.primary ? undefined : p.name)}\`)`, entryPoints: [entry], service: key, middlewares: ['bivouac-preview-auth'],
        ...(tls ? { tls } : {}),
      };
      if (t.alias) {
        // the project's alias points at this task: same service, same access check, a stable host
        const akey = `${key}-alias`;
        routers[akey] = { rule: `Host(\`${aliasHost(cfg, t.alias, p.primary ? undefined : p.name)}\`)`, entryPoints: [entry], service: key, middlewares: ['bivouac-preview-auth'], ...(tls ? { tls } : {}) };
      }
      services[key] = { loadBalancer: { passHostHeader: true, servers: [{ url: `http://${cfg.namePrefix}-task-${t.id}:${p.port}` }] } };
    }
  }
  return {
    http: {
      routers,
      services,
      middlewares: {
        'bivouac-restarting': { errors: { status: ['502-504'], service: 'bivouac-pages', query: '/restarting.html' } },
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
