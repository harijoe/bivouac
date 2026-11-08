import { truncateOutput } from '@bivouac/shared';

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
  services?: { name: string; image: string; env?: Record<string, string> }[];
}

/** What the agent needs to know about ports and sidecars, and how to change them. Shown at every session start. */
export function describeEnvironment(c: Pick<PromptContext, 'ports' | 'services'> & { configError?: string | null }): string[] {
  const out: string[] = [];
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
