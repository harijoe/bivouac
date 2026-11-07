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
  ].join('\n');
}

export function buildRetryPrompt(opts: { checkOutput: string; exitCode: number; successCommand: string; instructions: string[]; iteration: number; maxIterations: number }): string {
  const parts = [
    `The success command \`${opts.successCommand}\` failed with exit code ${opts.exitCode} (iteration ${opts.iteration}/${opts.maxIterations}). Output (truncated):`,
    '```',
    truncateOutput(opts.checkOutput, 6000),
    '```',
    'Fix the problem, commit your changes, and make sure the command passes.',
  ];
  if (opts.instructions.length) parts.push('', 'Additional instructions from the user:', ...opts.instructions.map((i) => `- ${i}`));
  return parts.join('\n');
}

export function buildInstructionPrompt(instructions: string[]): string {
  return ['New instructions from the user:', ...instructions.map((i) => `- ${i}`), '', 'Apply them, commit your changes, and make sure the success command passes.'].join('\n');
}
