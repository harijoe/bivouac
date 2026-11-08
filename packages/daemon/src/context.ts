import type { Context } from 'hono';
import type { Auth, RateLimiter, User } from './auth.js';
import type { DaemonConfig } from './config.js';
import type { Store } from './db.js';
import type { GithubApp } from './githubapp.js';
import type { OAuthServer } from './oauth.js';
import type { Previews } from './preview.js';
import type { TaskManager } from './runner.js';
import type { Service } from './service.js';
import type { LoginSession } from './executor.js';
import type { Updates } from './updates.js';

/** What the web service needs from the executor for the Claude sign-in; implemented over HTTP in production and locally in tests. */
export interface LoginClient {
  loginStart(): Promise<LoginSession>;
  loginGet(id: string): Promise<LoginSession>;
  loginInput(id: string, text: string): Promise<unknown>;
  loginCancel(id: string): Promise<unknown>;
}

export interface Ctx {
  cfg: DaemonConfig;
  store: Store;
  mgr: TaskManager;
  svc: Service;
  auth: Auth;
  gh: GithubApp;
  oauth: OAuthServer;
  previews: Previews;
  updates: Updates;
  limiter: RateLimiter;
  login: LoginClient | null;
  /** Public IPv4 of the server (DNS instructions in the setup wizard). */
  publicIp: string | null;
  /** Resolves hostnames (injectable for tests). */
  resolve4: (host: string) => Promise<string[]>;
}

export type AppEnv = { Variables: { user: User | null } };
export type C = Context<AppEnv>;

export const clientIp = (c: Context) => (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
