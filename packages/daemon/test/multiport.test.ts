import { describe, it, expect } from 'vitest';
import { addTask, makeEnv, makeRemote } from './helpers.js';

const OK = 'grep -q ok fake-output.txt';
const run = async (env: ReturnType<typeof makeEnv>, id: number) => { env.mgr.enqueue(id); await env.mgr.settled(id); return env.store.getTask(id)!; };
// first check writes a new bivouac.yml and fails, so a second agent session starts and must pick the change up
const writing = (yml: string) => `[ -f .once ] || { touch .once; printf '${yml}' > bivouac.yml; exit 3; }; ${OK}`;

describe('ports and services re-read between agent sessions', () => {
  it('a port added by the agent gets its URL, a service is declared, and the prompt mentions them', async () => {
    const env = makeEnv(); const remote = makeRemote();
    const t = addTask(env, remote, { prompt: 'do it FAKE_SCENARIO=fail-then-succeed', success: writing('ports:\\n  web: 5173\\n  api: 3000\\nservices:\\n  postgres:\\n    image: postgres:16\\n') });
    const r = await run(env, t.id);
    expect(r.status).toBe('succeeded');
    expect(r.ports.map((p) => [p.name, p.port, p.primary])).toEqual([['web', 5173, true], ['api', 3000, false]]);
    expect(r.ports[0].url).toBe(`https://${t.name}.demo.1-2-3-4.sslip.io`);
    expect(r.ports[1].url).toBe(`https://api.${t.name}.demo.1-2-3-4.sslip.io`);
    expect(r.services).toEqual([{ name: 'postgres', image: 'postgres:16' }]);
    expect(env.store.routeTasks().find((x) => x.id === t.id)!.ports).toHaveLength(2);
    expect(env.store.listEvents(t.id).some((e) => e.data.subtype === 'config_changed')).toBe(true);
    // the preview host of the extra port resolves to the same task
    expect(env.ctx.previews.taskForHost(`api.${t.name}.demo.1-2-3-4.sslip.io`)?.id).toBe(t.id);
    expect(env.ctx.previews.taskForHost(`nope.${t.name}.demo.1-2-3-4.sslip.io`)).toBeNull();
  });

  it('an invalid bivouac.yml keeps the last valid configuration and reports the error', async () => {
    const env = makeEnv(); const remote = makeRemote({ 'README.md': 'x\n', 'bivouac.yml': 'ports:\n  web: 5173\n  admin: 4000\n' });
    const t = addTask(env, remote, { prompt: 'do it FAKE_SCENARIO=fail-then-succeed', success: writing('ports: [oops\\n') });
    const r = await run(env, t.id);
    expect(r.status).toBe('succeeded');
    expect(r.ports.map((p) => p.name)).toEqual(['web', 'admin']);
    expect(r.configError).toBeTruthy();
    expect(env.store.listEvents(t.id).some((e) => e.data.subtype === 'config_warning')).toBe(true);
  });

  it('a removed port loses its URL', async () => {
    const env = makeEnv(); const remote = makeRemote({ 'README.md': 'x\n', 'bivouac.yml': 'ports:\n  web: 5173\n  admin: 4000\n' });
    const t = addTask(env, remote, { prompt: 'do it FAKE_SCENARIO=fail-then-succeed', success: writing('ports:\\n  web: 5173\\n') });
    const r = await run(env, t.id);
    expect(r.ports.map((p) => p.name)).toEqual(['web']);
    expect(env.ctx.previews.taskForHost(`admin.${t.name}.demo.1-2-3-4.sslip.io`)).toBeNull();
  });
});
