import type { DaemonConfig } from './config.js';
import type { Store } from './db.js';
import { TOKEN_LIFETIME_DAYS } from './claude.js';

export interface ResolvedClaude {
  /** null for credentials that come from the server environment (older installs without any account). */
  id: number | null;
  name: string;
  kind: 'oauth' | 'apikey';
  secret: string;
  expired: boolean;
  expiresAt: string | null;
}

/**
 * The Claude account a project uses: the one it chose, else the default account. Called at the start of every agent
 * session, so changing a project's account applies to the next attempt without restarting anything.
 * Without any account the credentials of the server environment (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) are used.
 */
export function resolveClaude(store: Store, cfg: Pick<DaemonConfig, 'oauthToken' | 'apiKey'>, projectId?: number): ResolvedClaude | null {
  const project = projectId !== undefined ? store.getProject(projectId) : null;
  const chosen = project?.claudeAccountId ? store.getClaudeAccount(project.claudeAccountId, TOKEN_LIFETIME_DAYS) : null;
  const account = chosen ?? store.getDefaultClaudeAccount(TOKEN_LIFETIME_DAYS);
  if (account) {
    const secret = store.getClaudeSecret(account.id);
    return secret ? { id: account.id, name: account.name, kind: account.kind, secret, expired: account.expired, expiresAt: account.expiresAt } : null;
  }
  if (cfg.apiKey) return { id: null, name: 'Default', kind: 'apikey', secret: cfg.apiKey, expired: false, expiresAt: null };
  if (cfg.oauthToken) return { id: null, name: 'Default', kind: 'oauth', secret: cfg.oauthToken, expired: false, expiresAt: null };
  return null;
}

/** Environment variables that give the CLI this account (the other kind is never set, so there is no ambiguity). */
export const claudeEnv = (c: ResolvedClaude | null): Record<string, string> =>
  !c ? {} : c.kind === 'apikey' ? { ANTHROPIC_API_KEY: c.secret } : { CLAUDE_CODE_OAUTH_TOKEN: c.secret };
