import { it, expect } from 'vitest';
import { mockGithub } from './ghmock.js';
import { makeEnv } from './helpers.js';
const cookies = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
it('a member of an allowed organisation keeps a working session', async () => {
  const gh = mockGithub({ orgMembers: { acme: ['bob'] } });
  const env = makeEnv({}, { github: gh.impl });
  env.ctx.auth.addAllowed('org', 'acme');
  const start = await env.app.request('/auth/github/start?next=/projects');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const r = await env.app.request(`/auth/github/callback?code=bob&state=${state}`, { headers: { cookie: cookies(start) } });
  const me: any = await (await env.app.request('/api/session', { headers: { cookie: cookies(r) } })).json();
  expect(me.user).not.toBeNull();
});
