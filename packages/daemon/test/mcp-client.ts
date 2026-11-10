import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import type { makeEnv } from './helpers.js';

export async function connect(env: ReturnType<typeof makeEnv>) {
  const g = env.ctx.oauth.registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const code = env.ctx.oauth.issueCode({ clientId: g.clientId, githubId: 42, redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'x'.repeat(43) });
  // exchange the code directly through the DB-level API (PKCE is covered in oauth.test.ts)
  env.store.db.prepare('UPDATE oauth_codes SET code_challenge = ?').run(require_s256('v'.repeat(50)));
  const tokens = env.ctx.oauth.exchangeCode({ code, client_id: g.clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'v'.repeat(50) }).tokens;
  const transport = new StreamableHTTPClientTransport(new URL('https://1-2-3-4.sslip.io/mcp'), {
    fetch: (async (u: any, init: any) => env.app.request(String(u).replace('https://1-2-3-4.sslip.io', ''), init)) as typeof fetch,
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
}
import { createHash } from 'node:crypto';
const require_s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

