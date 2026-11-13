import type { Session } from '@/api';

/** Response of GET /api/settings (see routes-api.ts). */
export interface SettingsData {
  admin: boolean; baseUrl: string; domain: string; sslip: boolean; publicIp: string | null; mcpUrl: string; version: string;
  /** Status of the default Claude account (see GET /api/claude/accounts for the list). */
  claude: { connected: boolean; kind: 'oauth' | 'apikey' | null; expiresAt: string | null; expired: boolean; accountName?: string | null; accounts?: number };
  github: { configured: boolean; slug: string | null; installUrl: string | null; appUrl: string | null };
  context7: { configured: boolean };
  budgets: { maxIterations: number | null; maxCostUsd: number | null };
  users: { githubId: number; login: string; role: string }[]; allowlist: { id: number; kind: string; value: string; label: string | null }[];
  redirectAllow: string[];
  grants: { id: string; clientName: string; login: string | null; createdAt: string; lastUsedAt: string | null }[];
}
/** What every settings section receives. `reload()` refetches /api/settings. */
export interface SectionProps { s: SettingsData; session: Session; reload: () => void }
