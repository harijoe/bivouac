import dns from 'node:dns/promises';
import { Auth, RateLimiter } from './auth.js';
import type { DaemonConfig } from './config.js';
import type { Ctx, LoginClient } from './context.js';
import { Store } from './db.js';
import { GithubApp } from './githubapp.js';
import { OAuthServer } from './oauth.js';
import { Previews } from './preview.js';
import { TaskManager, type SandboxFactory } from './runner.js';
import { Service } from './service.js';

export interface BuildOpts {
  cfg: DaemonConfig;
  store: Store;
  makeSandbox: SandboxFactory;
  login?: LoginClient | null;
  fetchImpl?: typeof fetch;
  publicIp?: string | null;
  resolve4?: (host: string) => Promise<string[]>;
}

/** Wires the web service together. Shared by the real entry point and the tests. */
export function buildContext(o: BuildOpts): Ctx {
  const { cfg, store } = cfg0(o);
  const auth = new Auth(store);
  const gh = new GithubApp(store, o.fetchImpl ?? fetch);
  const previews = new Previews(store, cfg, cfg.secretKey);
  // The manager needs the service for repo tokens, the service needs the manager: tie the knot lazily.
  const ref: { svc?: Service } = {};
  const mgr = new TaskManager(store, cfg, o.makeSandbox, (p, access) => ref.svc!.repoToken(p, access), o.fetchImpl);
  const svc = new Service(store, cfg, mgr, auth, gh, previews);
  ref.svc = svc;
  const oauth = new OAuthServer(store, () => cfg.oauthRedirectAllow);
  return {
    cfg, store, mgr, svc, auth, gh, oauth, previews, limiter: new RateLimiter(), login: o.login ?? null,
    publicIp: o.publicIp ?? process.env.BIVOUAC_PUBLIC_IP ?? null, resolve4: o.resolve4 ?? ((h) => dns.resolve4(h)),
  };
}
const cfg0 = (o: BuildOpts) => ({ cfg: o.cfg, store: o.store });

export { Store };
