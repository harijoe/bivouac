import { truncateOutput, type Tooling } from '@bivouac/shared';

export interface PromptContext {
  prompt: string;
  branch: string;
  baseBranch: string;
  previewUrl: string | null;
  devCommand: string | null;
  devLogPath: string;
  successCommand: string;
  iteration: number;
  maxIterations: number;
  ports?: { name: string; port: number; primary: boolean; url: string }[];
  configError?: string | null;
  /** Stable URL when the project's alias points at this task. */
  aliasUrl?: string | null;
  services?: { name: string; image: string; env?: Record<string, string> }[];
  /** Tool versions installed for the task, as `node 26, pnpm 11`. */
  runtime?: string;
  tooling?: Tooling | null;
}

/** The MCP servers and skills of this session, and the rule that UI work is checked in a browser before it counts as done. */
export function describeToolbox(t: Tooling | null | undefined, previewUrl?: string | null): string[] {
  if (!t) return [];
  const out: string[] = [];
  const mcp = t.mcp.filter((m) => m.status !== 'skipped');
  const has = (n: string) => mcp.some((m) => m.name === n);
  if (mcp.length) out.push(`- MCP servers available in this session: ${mcp.map((m) => m.name).join(', ')}. Their tools are named \`mcp__<server>__<tool>\`.`);
  if (has('playwright')) out.push(`- The \`playwright\` MCP server drives a headless Chromium inside your container, so the app and its dev server are reachable at http://localhost:<port> for every port you declared${previewUrl ? ` (the public preview URL ${previewUrl} also works)` : ''}. Use it to open pages, take snapshots and screenshots, click, type, read the console and the network.`);
  if (has('context7')) out.push('- The `context7` MCP server gives current documentation for libraries and frameworks (resolve the library id, then fetch its docs). Prefer it to memory when you use an API you are not sure of.');
  if (t.skills.length) out.push(`- Skills available (the Skill tool loads them when relevant): ${t.skills.map((s) => s.name).join(', ')}.`);
  if (t.skills.some((x) => x.source === 'catalogue')) out.push('- Skills from the catalogue run no hook of their own in bivouac: a "gate" or "finish check" they describe is advice you apply yourself (run it only if it ends within a few minutes). Only the success command decides whether the task succeeded.');
  if (has('playwright')) out.push('- Every change that touches the user interface must be checked on the running preview with the browser before you consider the work finished: open the affected pages at 375 px wide and at 1280 px wide (resize the browser window), look at the result, and read the console for errors. Fix what you find. A change you did not look at is not finished.');
  return out;
}

/** What the agent needs to know about ports and sidecars, and how to change them. Shown at every session start. */
export function describeEnvironment(c: Pick<PromptContext, 'ports' | 'services'> & { configError?: string | null; aliasUrl?: string | null }): string[] {
  const out: string[] = [];
  if (c.aliasUrl) out.push(`- This task is where the project's stable alias points: ${c.aliasUrl}. Use that URL (not the task URL) for OAuth redirect URIs and webhooks of the app you are building; it stays the same when the alias moves to another task.`);
  if (c.ports && c.ports.length > 1) {
    out.push('- Exposed ports: ' + c.ports.map((p) => `${p.name} (port ${p.port})${p.url ? ` at ${p.url}` : ''}${p.primary ? ' [main]' : ''}`).join('; ') + '.');
  }
  if (c.services?.length) {
    out.push('- Services available on the task network (not on the internet, each task has its own instance): ' +
      c.services.map((s) => `\`${s.name}\` (${s.image}) reachable as host \`${s.name}\``).join('; ') +
      '. Use the service name as host name (for example `postgres:5432`), never localhost. Their credentials are the ones set in `bivouac.yml`.');
  }
  out.push('- You may declare more ports and services by editing `bivouac.yml` at the repository root and committing it (`ports: { web: 5173, api: 3000 }`, `services: { postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: dev }, volume: /var/lib/postgresql/data } }`). It is re-read when your next session starts: a new port gets its own preview URL, a new service is started for you.');
  if (c.configError) out.push(`- WARNING: your last \`bivouac.yml\` is invalid and was ignored (the previous valid configuration is still in use): ${c.configError}. Fix it.`);
  return out;
}

/** Tool versions, and what to do when the agent cannot go on. Part of the system prompt of every task. */
export function describeTooling(runtime?: string): string[] {
  return [
    runtime
      ? `- Tool versions already installed for this task and on your PATH: ${runtime} (taken from the repository's own files such as .nvmrc, package.json "engines", mise.toml, or from \`runtime:\` in bivouac.yml).`
      : '- The tools of the base image are available (Node.js, pnpm, git).',
    '- If you need another tool or version, you may install it without root: try it with `mise exec python@3.12 -- python script.py`, then make it reproducible by adding it under `runtime:` in `bivouac.yml` (for example `runtime: { node: "26", python: "3.12" }`) or in the `setup:` command, and commit that. It is installed again at the start of your next session. Never edit the repository to get around a version requirement (`engines`, `.nvmrc`, lockfile versions…).',
    '- If you cannot go on (something is needed that requires root such as system packages, a secret, a decision from the user, access you do not have), do not keep trying and do not loop: write what blocks you and what you expect from the user to `/workspace/.bivouac/blocked.md` (outside the repository), then end your turn. The task then goes to "blocked" and waits for the user instead of burning tokens.',
  ];
}

export function buildInitialPrompt(c: PromptContext): string {
  return [
    c.prompt.trim(),
    '',
    '---',
    'Context (added by bivouac):',
    `- You are working in /workspace/repo on git branch \`${c.branch}\` (created from \`${c.baseBranch}\`). Commit regularly with clear messages; do not switch branches.`,
    c.devCommand
      ? `- The app is already running in dev mode with hot reload (\`${c.devCommand}\`)${c.previewUrl ? ` and is visible at ${c.previewUrl}` : ''}. Do not start another dev server. Dev server logs: \`tail -n 100 ${c.devLogPath}\`.`
      : '- No dev server is configured.',
    `- Success criterion: this command must exit with status 0 — \`${c.successCommand}\`. It is run automatically after you finish; if it fails you will be asked to fix it (iteration ${c.iteration}/${c.maxIterations}). Run it yourself before finishing.`,
    ...describeEnvironment(c),
    '- bivouac watches the dev server: if it dies or stops answering it is restarted with a growing delay (and you are told in your next session). Its state is in `/workspace/.bivouac/health.json`. To restart it yourself: `touch /workspace/.bivouac/restart.req`. A health path other than `/` can be set with `preview: { health: { path: /health } }` in `bivouac.yml`.',
    '- After each attempt bivouac opens the pages listed under `preview: { screenshots: ["/", "/login"] }` in `bivouac.yml` (default `/`) at 375 px and 1280 px wide, and records errors from the browser console, so keep those pages free of errors.',
    ...describeTooling(c.runtime),
    ...describeToolbox(c.tooling, c.previewUrl),
  ].join('\n');
}

export function buildRetryPrompt(opts: { env?: string[]; checkOutput: string; exitCode: number; successCommand: string; instructions: string[]; iteration: number; maxIterations: number }): string {
  const parts = [
    `The success command \`${opts.successCommand}\` failed with exit code ${opts.exitCode} (iteration ${opts.iteration}/${opts.maxIterations}). Output (truncated):`,
    '```',
    truncateOutput(opts.checkOutput, 6000),
    '```',
    'Fix the problem, commit your changes, and make sure the command passes.',
    ...(opts.env ?? []),
  ];
  if (opts.instructions.length) parts.push('', 'Additional instructions from the user:', ...opts.instructions.map((i) => `- ${i}`));
  return parts.join('\n');
}

export function buildInstructionPrompt(instructions: string[], env: string[] = []): string {
  return ['New instructions from the user:', ...instructions.map((i) => `- ${i}`), '', 'Apply them, commit your changes, and make sure the success command passes.', ...env].join('\n');
}
