import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { UserError, type Actor, type Service } from './service.js';

type Ann = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
const READ: Ann = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE: Ann = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const EXTERNAL: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

/** A tool result that carries images (screenshots) next to its JSON. */
class WithImages { constructor(public data: unknown, public images: { data: string; mimeType: string }[]) {} }
const ok = (obj: unknown) => {
  const text = (o: unknown) => ({ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) });
  if (obj instanceof WithImages) return { content: [text(obj.data), ...obj.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))] };
  return { content: [text(obj)] };
};
const fail = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

const LIMIT_PARAMS = {
  max_cost_usd: z.number().positive().optional().describe('New total budget in USD for the whole task (not an increment).'),
  max_iterations: z.number().int().positive().optional().describe('New total number of attempts allowed for the whole task.'),
  max_tokens: z.number().int().positive().optional().describe('New total token limit.'),
  success_command: z.string().optional().describe('New success command (must exit 0 when the work is done).'),
};
const PROJECT = z.string().describe('Project name (see list_projects), for example "my-app".');
const TASK = z.string().describe('Task name, unique inside the project, for example "login-page".');

export function buildMcpServer(svc: Service, actor: Actor): McpServer {
  const server = new McpServer({ name: 'bivouac', version: process.env.BIVOUAC_VERSION ?? 'dev' }, {
    instructions: 'bivouac runs Claude Code agents in isolated containers, one task per agent, each with a live preview URL. ' +
      'Typical flow: list_projects, then create_task (it returns immediately), then poll get_task until the status is succeeded, failed, budget_exceeded, max_iterations, stopped, blocked or stuck. A blocked task states in `error` what it needs: answer with resume_task and an instruction. ' +
      'Before proposing a new mission, call get_project_context (or use the plan_next_mission prompt) to see where the project stands. Share the previewUrl with the user. Use send_instruction to steer a running task and push_branch / open_pr to deliver the work.',
  });
  const tool = <S extends z.ZodRawShape>(name: string, title: string, description: string, annotations: Ann, schema: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown) =>
    server.registerTool(name, { title, description, inputSchema: schema, annotations }, (async (args: z.infer<z.ZodObject<S>>) => {
      try { return ok(await fn(args)); } catch (e: any) {
        if (e instanceof UserError) return fail(e.message);
        return fail(`Unexpected error: ${String(e?.message ?? e)}. Retry once; if it persists, ask the user to check the bivouac dashboard.`);
      }
    }) as never);

  tool('list_projects', 'List projects', 'List the projects (GitHub repositories) bivouac can work on, with their task counts and total cost. Call this first to get valid project names. Projects are added by the user in the dashboard, not through this tool.', READ, {},
    () => svc.listProjects().map((p) => ({ name: p.name, repository: p.githubRepo ?? p.repoUrl, defaultBranch: p.defaultBranch, tasks: p.totals.tasks, totalCostUsd: Number(p.totals.costUsd.toFixed(4)), claudeAccount: p.claudeAccountName })));

  tool('list_tasks', 'List tasks', 'List tasks with their status, cost and preview URL, newest first. Optionally filter by project or status. Statuses: queued, starting, running, checking (running the success command), succeeded, failed, budget_exceeded, max_iterations, stopped, blocked (the agent cannot continue and says what it needs: answer with resume_task and a message), stuck (the same check failed twice with no code change). costUsd is the API-equivalent estimate when costKind is estimated_api_equivalent (Claude subscription: not a spend).', READ,
    { project: PROJECT.optional(), status: z.string().optional().describe('Only tasks with this status.') },
    (a) => {
      const p = a.project ? svc.resolveProject(a.project) : null;
      return svc.store.listTasks(p?.id).filter((t) => !a.status || t.status === a.status).map((t) => svc.summary(t));
    });

  tool('get_task', 'Get task details', 'Get one task: status, iteration, cost (costKind says whether it is a real cost or an API-equivalent estimate on a subscription), the reason when blocked or stuck (error), the last messages from the agent (summarised), the result of the last success check, the preview URL, the dashboard link, the PR link and active share links, and a summary per attempt (newest first, 10 by default: start time, duration, cost, result of the success check, beginning of the last agent message, what triggered it). For a long task pass attempts_before (the attemptsNextBefore of the previous answer) to read older attempts. The result also carries the screenshots of the last attempt as images (375 px and 1280 px wide, compressed, at most 4) with their problems (HTTP status, console errors, failed requests, blank page); ask get_attempt_screenshots for another attempt or for full-size images. The `tooling` field lists the MCP servers (name, built-in or project, status) and the skills (name, source) the agent had in its last session. Poll this after create_task until the status is final.', READ,
    { project: PROJECT, task: TASK, attempts_limit: z.number().int().min(1).max(50).optional().describe('How many attempts to list (default 10, newest first).'), attempts_before: z.number().int().positive().optional().describe('Pagination: list attempts older than this attempt number (use attemptsNextBefore from the previous answer).') },
    async (a) => {
      const t = svc.resolveTask(a.project, a.task);
      const d = await svc.describeTask(t, { attemptsBefore: a.attempts_before, attemptsLimit: a.attempts_limit });
      const [latest] = svc.shotsOf(t, { limit: 1 });
      if (!latest) return d;
      const { images, listed } = svc.mcpShots(t, latest);
      return new WithImages({ ...d, screenshots: listed }, images);
    });

  tool('get_attempt_diff', 'Get what an attempt changed', 'Read what one attempt of a task changed: the list of files with +added/-deleted lines and the commits the agent made, or the patch itself, a window of lines at a time. Includes changes the agent did not commit. `attempt` is a number (see the attempts in get_task, each with its `changes`) or "base" for everything the task changed compared with its base branch. Without `file` the patch of all files is returned file after file; pass `file` for one file. When `truncated` is true, ask again with offset = nextOffset to read on.', READ,
    { project: PROJECT, task: TASK, attempt: z.union([z.number().int().positive(), z.literal('base')]).describe('Attempt number, or "base" for the whole task against its base branch.'),
      file: z.string().max(500).optional().describe('Path of one changed file. Leave out for the file list plus the start of the whole patch.'),
      offset: z.number().int().min(0).optional().describe('First line of the patch to return (default 0).'), limit: z.number().int().min(1).max(1500).optional().describe('How many lines (default 400).') },
    async (a) => {
      const t = svc.resolveTask(a.project, a.task);
      const sum = await svc.attemptDiff(t, a.attempt);
      const patch = await svc.attemptPatch(t, a.attempt, a.file, a.offset ?? 0, a.limit ?? 400);
      return { attempt: a.attempt, comparedWith: sum.against, live: sum.live, totals: sum.totals, commits: sum.commits, uncommittedChanges: sum.uncommitted,
        files: sum.files.map((f) => ({ path: f.path, ...(f.oldPath ? { renamedFrom: f.oldPath } : {}), status: f.status, added: f.added, deleted: f.deleted, ...(f.binary ? { binary: true } : {}) })),
        patch: patch.lines.join('\n'), file: patch.file, offset: patch.offset, totalLines: patch.total, truncated: patch.truncated, nextOffset: patch.nextOffset, binary: patch.binary };
    });

  tool('create_task', 'Create and start a task',
    'Start a Claude Code agent on a project, in its own container, branch and live preview. Returns immediately with the preview URL and dashboard link; use get_task to follow progress. ' +
    'The agent works until the success command exits with 0 (retrying with the failure output) or a budget is reached. Choose a short unique name (lowercase letters, digits, dashes): it becomes part of the preview URL. ' +
    'Pass an idempotency_key to make retries safe (same key = same task, no duplicate).', EXTERNAL,
    {
      project: PROJECT, name: z.string().describe('Task name: lowercase letters, digits and dashes, 1 to 40 characters, unique in the project. Used in the preview URL.'),
      prompt: z.string().describe('What the agent must do. Be specific about the expected behaviour.'),
      success_command: z.string().optional().describe('Shell command that must exit 0 when the work is done, for example "pnpm test && pnpm build". Defaults to the project configuration.'),
      max_iterations: z.number().int().positive().optional().describe('Maximum agent runs (default from project config, usually 10).'),
      max_cost_usd: z.number().positive().optional().describe('Maximum spend in USD (default from project config, usually 20).'),
      max_tokens: z.number().int().positive().optional(), base_branch: z.string().optional().describe('Branch to start from (default: the repository default branch).'),
      idempotency_key: z.string().max(100).optional().describe('Reuse the same key when retrying a failed call to avoid creating a duplicate task.'),
    },
    async (a) => {
      const { task, created } = await svc.createTask({ project: a.project, name: a.name, prompt: a.prompt, successCommand: a.success_command, maxIterations: a.max_iterations, maxCostUsd: a.max_cost_usd, maxTokens: a.max_tokens, baseBranch: a.base_branch, idempotencyKey: a.idempotency_key }, actor);
      return { ...svc.summary(task), started: created, note: created ? 'Task started. Poll get_task for progress.' : 'A task with this idempotency_key already exists; returning it.' };
    });

  tool('send_instruction', 'Send an instruction to a task', 'Send a message to the agent of a task. If the agent is running, the instruction is queued and applied at its next iteration; if the task has finished, it is resumed with this instruction.', WRITE,
    { project: PROJECT, task: TASK, text: z.string().describe('The instruction, written for the agent.') },
    async (a) => {
      const t = svc.resolveTask(a.project, a.task);
      const r = await svc.instruct(t, a.text, actor);
      return { ok: true, queued: r.queued, note: r.queued ? 'Queued: the agent will see it at its next iteration.' : 'Task resumed with your instruction.' };
    });

  tool('stop_task', 'Stop a task', 'Stop the agent of a running task. The container, files and branch are kept; resume_task continues later.', DESTRUCTIVE,
    { project: PROJECT, task: TASK },
    async (a) => svc.summary(await svc.stopTask(svc.resolveTask(a.project, a.task), actor)));

  tool('resume_task', 'Resume a task', 'Continue a stopped or finished task (failed, budget_exceeded, max_iterations, stopped, blocked, stuck). Optionally add an instruction. A task stopped on max_iterations gets a fresh allowance of attempts unless you pass max_iterations; a task stopped on budget_exceeded cannot continue unless you also pass a higher max_cost_usd (a total, not an increment): the call fails with an explanation otherwise. The other limits can be changed at the same time.', WRITE,
    { project: PROJECT, task: TASK, text: z.string().optional().describe('Optional instruction to give when resuming.'), ...LIMIT_PARAMS },
    async (a) => svc.summary(await svc.resumeTask(svc.resolveTask(a.project, a.task), actor, a.text, { maxCostUsd: a.max_cost_usd, maxIterations: a.max_iterations, maxTokens: a.max_tokens, successCommand: a.success_command })));

  tool('update_task', 'Change the limits of a task', 'Change the budget (max_cost_usd), the maximum number of attempts (max_iterations), the token limit (max_tokens) and/or the success command of an existing task, without recreating it. The new values apply from the next attempt (an attempt that is already running keeps its cap). To continue a task that stopped on its budget, prefer resume_task with a higher max_cost_usd. Values are totals for the whole task, not increments: a task that has spent $18 of $20 needs max_cost_usd above 18, for example 30.', WRITE,
    { project: PROJECT, task: TASK, ...LIMIT_PARAMS },
    (a) => svc.summary(svc.updateTaskLimits(svc.resolveTask(a.project, a.task), { maxCostUsd: a.max_cost_usd, maxIterations: a.max_iterations, maxTokens: a.max_tokens, successCommand: a.success_command }, actor)));

  tool('get_attempt_screenshots', 'Get the screenshots of an attempt', 'Photographs of the preview taken at the end of an attempt (pages listed under preview.screenshots in bivouac.yml, default "/"), as images, each with its HTTP status, page title, browser console errors, failed requests and whether the page is blank or shows an error. Use it to check the result visually instead of asking the user. Default: the last attempt that has screenshots, compressed images (375 px = phone, 1280 px = laptop). Pass variant "full" for the full-size page (at most 4 images, larger). Old attempts are kept for a limited time.', READ,
    { project: PROJECT, task: TASK, attempt: z.number().int().positive().optional().describe('Attempt number (default: the last one with screenshots).'),
      width: z.union([z.literal(375), z.literal(1280)]).optional().describe('Only this width: 375 (phone) or 1280 (laptop). Default: both.'),
      variant: z.enum(['compressed', 'full']).default('compressed').describe('"compressed" (default, small) or "full" (full-size page).') },
    (a) => {
      const t = svc.resolveTask(a.project, a.task);
      const [att] = svc.shotsOf(t, a.attempt !== undefined ? { attempt: a.attempt } : { limit: 1 });
      if (!att) throw new UserError(a.attempt !== undefined ? `No screenshots for attempt ${a.attempt}: it was not photographed, or its screenshots were removed to keep the storage bounded (only the newest attempts are kept).` : 'This task has no screenshots yet: they are taken at the end of each attempt, when the dev server answers.', 'no_shots', 404);
      const { images, listed } = svc.mcpShots(t, att, { width: a.width, full: a.variant === 'full' });
      return new WithImages({ attempt: att.attempt, checkPassed: att.checkPassed, captureError: att.error, screenshots: listed }, images);
    });

  tool('restart_preview', 'Restart the dev server of a task', 'Restart the dev server (the preview) of a running task now, for example when get_task shows preview.state "down" or "unhealthy". bivouac already restarts a crashed dev server by itself with a growing delay and gives up after 8 tries; this starts it again from scratch.', WRITE,
    { project: PROJECT, task: TASK },
    async (a) => svc.summary(await svc.restartPreview(svc.resolveTask(a.project, a.task), actor)));

  tool('set_project_alias_task', 'Point the project alias at a task', 'Make the stable alias URL of a project (for example https://app.<domain>, defined by the owner in the project settings) open the preview of this task, or pass no task to detach it. Use it for OAuth redirect URIs and webhooks of the app under test: the URL stays the same while the task behind it changes. The previous task loses the alias.', WRITE,
    { project: PROJECT, task: TASK.optional().describe('Task to point the alias at. Leave out to detach the alias.') },
    (a) => { const p = svc.setAlias(a.project, { task: a.task ?? null }, actor); const t = p.aliasTaskId ? svc.store.getTask(p.aliasTaskId) : null; return { alias: p.alias, task: t?.name ?? null, url: t?.aliasUrl ?? null }; });

  tool('create_share_link', 'Create a preview share link', 'Create a link that lets someone without a bivouac account view the live preview of this task only. Choose how long it stays valid (1h, 24h, 7d or never). Anyone with the link can see the preview until it expires or is revoked; a visitor with an expired link sees an explanation page.', WRITE,
    { project: PROJECT, task: TASK, duration: z.enum(['1h', '24h', '7d', 'never']).default('24h').describe('How long the link works.') },
    (a) => svc.createShareLink(svc.resolveTask(a.project, a.task), a.duration, actor));

  tool('revoke_share_link', 'Revoke a preview share link', 'Immediately disable a share link. Get link ids from get_task (shareLinks).', DESTRUCTIVE,
    { project: PROJECT, task: TASK, link_id: z.number().int().describe('Id of the share link.') },
    (a) => { svc.revokeShareLink(svc.resolveTask(a.project, a.task), a.link_id, actor); return { ok: true }; });

  tool('push_branch', 'Push the task branch to GitHub', 'Push the task branch (agent/t-<id>-<name>) to the GitHub repository. Does nothing harmful if already pushed.', EXTERNAL,
    { project: PROJECT, task: TASK },
    async (a) => { const t = await svc.pushBranch(svc.resolveTask(a.project, a.task), actor); return { ok: true, branch: t.branch }; });

  tool('open_pr', 'Open a pull request', 'Push the task branch if needed and open a pull request against the base branch. Returns the PR URL (or the existing PR if one is already open).', EXTERNAL,
    { project: PROJECT, task: TASK },
    async (a) => ({ url: await svc.openPr(svc.resolveTask(a.project, a.task), actor) }));

  tool('get_project_context', 'Get the state of a project', 'Read-only snapshot of a project at this moment, to plan its next step with the user: repository and default branch, last commit, effective bivouac.yml, README and project notes (CLAUDE.md, AGENTS.md, PROGRESS.md, NOTES.md, docs/decisions.md, CHANGELOG.md), code structure (folders, languages, sizes, no file contents), recent commits, recent and running tasks (prompt, status, iterations, cost, branch, PR state, what the agent did, last verification) and known problems. About 10 000 tokens by default. ' +
    'Use `detail` for more on one part: "task:<task name>" (everything about a task), "doc:<path>" (a whole document), "tree" (deeper structure) or "commits" (60 commits). The repository is refreshed from GitHub at each call. Secrets are never included. After reading it, propose the next mission and start it with create_task.', READ,
    { project: PROJECT, detail: z.string().max(300).optional().describe('Optional: "task:<name>", "doc:<path>", "tree" or "commits". Leave empty for the overview.') },
    async (a) => {
      try { return await svc.pctx.snapshot(svc.resolveProject(a.project), a.detail); } catch (e: any) { if (e instanceof UserError) throw e; throw new UserError(String(e?.message ?? e)); }
    });

  tool('read_project_file', 'Read a file of the repository', 'Read one file from the repository on the default branch (or another branch, tag or commit with `ref`), for example a source file mentioned in get_project_context. Read-only, at most 60 000 characters. Secrets, .env files and files ignored by git are refused.', READ,
    { project: PROJECT, path: z.string().max(500).describe('Path relative to the repository root, for example "src/index.ts".'), ref: z.string().max(200).optional().describe('Branch, tag or commit. Default: the default branch.') },
    async (a) => {
      try {
        const f = await svc.pctx.readFile(svc.resolveProject(a.project), a.path, a.ref);
        return `${f.path} @ ${f.ref}${f.truncated ? ' (truncated to 60000 characters)' : ''}\n\n${f.content}`;
      } catch (e: any) { if (e instanceof UserError) throw e; throw new UserError(String(e?.message ?? e)); }
    });

  server.registerPrompt('plan_next_mission', {
    title: 'Plan the next mission',
    description: 'Review where a project stands and prepare the next mission: what is done, what is missing, and a ready-to-run prompt for create_task with its success command.',
    argsSchema: { project: z.string().describe('Project name (see list_projects).'), goal: z.string().optional().describe('Optional: what you would like to achieve next, in your own words.') },
  }, (a) => ({
    description: `Plan the next mission for ${a.project}`,
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: [
      `Help me plan the next mission for my project "${a.project}" in bivouac.${a.goal ? ` What I have in mind: ${a.goal}` : ''}`,
      '',
      '1. Call get_project_context with this project. Read it carefully; if something important is cut off, call it again with `detail` ("task:<name>", "doc:<path>", "tree") or read a file with read_project_file.',
      '2. Tell me in a few lines where the project stands: what works, what the recent tasks did (and whether their pull requests were merged), what is blocked or failing.',
      '3. Tell me what is missing or risky, and ask me questions if my goal is unclear. Do not guess.',
      '4. Propose the next mission: a short task name (lowercase letters, digits, dashes), a precise prompt for the agent (context, expected behaviour, constraints, what not to touch), and a success command that exits 0 only when the work is really done (tests, build, lint).',
      '5. Wait for my approval, then start it with create_task and follow it with get_task.',
    ].join('\n') } }],
  }));

  return server;
}

/** Handles one stateless MCP request (JSON response mode: no session to lose between requests). */
export async function handleMcp(svc: Service, actor: Actor, req: Request): Promise<Response> {
  const server = buildMcpServer(svc, actor);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(req); } finally { void server.close().catch(() => {}); }
}
