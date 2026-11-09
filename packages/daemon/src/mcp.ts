import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { UserError, type Actor, type Service } from './service.js';

type Ann = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
const READ: Ann = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE: Ann = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const EXTERNAL: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const ok = (obj: unknown) => ({ content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

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
    () => svc.listProjects().map((p) => ({ name: p.name, repository: p.githubRepo ?? p.repoUrl, defaultBranch: p.defaultBranch, tasks: p.totals.tasks, totalCostUsd: Number(p.totals.costUsd.toFixed(4)) })));

  tool('list_tasks', 'List tasks', 'List tasks with their status, cost and preview URL, newest first. Optionally filter by project or status. Statuses: queued, starting, running, checking (running the success command), succeeded, failed, budget_exceeded, max_iterations, stopped, blocked (the agent cannot continue and says what it needs: answer with resume_task and a message), stuck (the same check failed twice with no code change). costUsd is the API-equivalent estimate when costKind is estimated_api_equivalent (Claude subscription: not a spend).', READ,
    { project: PROJECT.optional(), status: z.string().optional().describe('Only tasks with this status.') },
    (a) => {
      const p = a.project ? svc.resolveProject(a.project) : null;
      return svc.store.listTasks(p?.id).filter((t) => !a.status || t.status === a.status).map((t) => svc.summary(t));
    });

  tool('get_task', 'Get task details', 'Get one task: status, iteration, cost (costKind says whether it is a real cost or an API-equivalent estimate on a subscription), the reason when blocked or stuck (error), the last messages from the agent (summarised), the result of the last success check, the preview URL, the dashboard link, the PR link and active share links. Poll this after create_task until the status is final.', READ,
    { project: PROJECT, task: TASK },
    (a) => svc.describeTask(svc.resolveTask(a.project, a.task)));

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

  tool('resume_task', 'Resume a task', 'Continue a stopped or finished task (failed, budget_exceeded, max_iterations, stopped, blocked, stuck) with a fresh iteration allowance. Optionally add an instruction.', WRITE,
    { project: PROJECT, task: TASK, text: z.string().optional().describe('Optional instruction to give when resuming.') },
    async (a) => svc.summary(await svc.resumeTask(svc.resolveTask(a.project, a.task), actor, a.text)));

  tool('create_share_link', 'Create a preview share link', 'Create a link that lets someone without a bivouac account view the live preview of this task only. Choose how long it stays valid. Anyone with the link can see the preview until it expires or is revoked.', WRITE,
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
    async (a) => svc.pctx.snapshot(svc.resolveProject(a.project), a.detail));

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
