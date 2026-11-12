export const TASK_STATUSES = [
  'queued', 'starting', 'running', 'checking', 'succeeded', 'failed',
  'budget_exceeded', 'max_iterations', 'stopped', 'blocked', 'stuck',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_STATUSES: TaskStatus[] = ['succeeded', 'failed', 'budget_exceeded', 'max_iterations', 'stopped', 'blocked', 'stuck'];
export const isTerminal = (s: TaskStatus) => TERMINAL_STATUSES.includes(s);

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });

export interface Project {
  id: number;
  name: string; // slug, used in hostnames
  repoUrl: string;
  /** `owner/repo` when the project comes from the GitHub App installation. */
  githubRepo: string | null;
  installationId: number | null;
  defaultBranch: string;
  hasGithubToken: boolean;
  config: import('./config.js').ProjectConfig;
  /** The Claude account this project uses; null = the default account. */
  claudeAccountId: number | null;
  /** Stable host label (`<alias>.<domain>`) a project can point at one of its tasks; null when unused. */
  alias: string | null;
  /** The task the alias currently points at. */
  aliasTaskId: number | null;
  /** Paths of the aliased preview that skip the access check (webhooks, OAuth callbacks): exact path or a prefix ending in `/`. */
  aliasPublicPaths: string[];
  createdAt: string;
}

/** A way to sign in to Claude: a subscription (long-lived OAuth token) or an API key. Secrets never leave the daemon. */
export interface ClaudeAccount {
  id: number;
  name: string;
  kind: 'oauth' | 'apikey';
  connectedAt: string;
  expiresAt: string | null;
  expired: boolean;
  isDefault: boolean;
  /** Projects that chose this account explicitly. */
  projects: number;
}

/** How the dev server of a task is doing, as seen by the supervisor inside the container. */
export interface PreviewHealth {
  /** unknown: nothing reported yet; starting: launched, not answering yet; healthy; unhealthy: not answering, a restart is planned; down: gave up; stopped: the task container is not running. */
  state: 'unknown' | 'starting' | 'healthy' | 'unhealthy' | 'down' | 'stopped';
  /** Since when the preview is in this state (ISO time). */
  since: string;
  lastHealthyAt: string | null;
  /** Restarts since it was last healthy. */
  restarts: number;
  /** Last known cause: a crash with its exit code or signal, a health check that failed, or the last words of the log. */
  cause: string | null;
  nextRetryAt: string | null;
  updatedAt: string;
}

export interface TaskPort { name: string; port: number; primary: boolean; url: string; aliasUrl?: string }
export interface TaskService { name: string; image: string }

export interface Task {
  id: number;
  projectId: number;
  projectName: string;
  /** Unique slug inside the project; first label of the preview hostname. */
  name: string;
  title: string;
  prompt: string;
  successCommand: string;
  branch: string;
  baseBranch: string;
  status: TaskStatus;
  iteration: number;
  maxIterations: number;
  maxCostUsd: number;
  maxTokens: number | null;
  sessionId: string | null;
  usage: Usage;
  previewUrl: string | null;
  devPort: number | null;
  /** Every exposed port with its URL (the primary one first). Empty until the task has started. */
  ports: TaskPort[];
  /** Sidecar services of the task. */
  services: TaskService[];
  /** Health of the dev server; null until the task has started one. */
  preview: PreviewHealth | null;
  /** Stable URL of the project's alias when it points at this task. */
  aliasUrl: string | null;
  /** Last problem found in bivouac.yml when it was re-read from the task branch (the last valid configuration stays in use). */
  configError: string | null;
  pushed: boolean;
  prUrl: string | null;
  error: string | null;
  /** Name of the Claude account used by the last agent session. */
  accountName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type EventKind =
  | 'status' | 'assistant_text' | 'tool_use' | 'tool_result' | 'result' | 'system'
  | 'user_instruction' | 'check' | 'error' | 'rate_limit';

export interface TaskEvent {
  id: number;
  taskId: number;
  iteration: number;
  kind: EventKind;
  data: any;
  createdAt: string;
}

/** Something that happened between two attempts of a task: an instruction, a state change, a change of limits. */
export interface HistoryMarker {
  id: number;
  kind: 'instruction' | 'state' | 'limits';
  at: string;
  /** instruction: the text; limits: the sentence describing the change. */
  text?: string;
  /** instruction: not yet taken into account by an agent. */
  queued?: boolean;
  /** state: the status the task went to. */
  status?: string;
  /** state: the reason (error, blocked or stuck explanation). */
  error?: string | null;
}

/** One agent attempt (one run of the agent plus its success check), as shown in the history header and by get_task. */
export interface AttemptSummary {
  attempt: number;
  startedAt: string;
  /** Last activity of the attempt; null while it is running. */
  endedAt: string | null;
  durationMs: number;
  running: boolean;
  /** Cost reported by the agent for this attempt (an API-equivalent estimate with a subscription); null until it ends. */
  costUsd: number | null;
  /** Result of the success check of this attempt; null when it did not get that far. */
  check: { passed: boolean; exitCode: number; command: string } | null;
  /** Beginning of the last thing the agent said in this attempt. */
  lastMessage: string | null;
  firstEventId: number;
  lastEventId: number;
  /** What happened just before this attempt started (instructions, resumption, limits changed, the reason it stopped before). */
  markers: HistoryMarker[];
}

export interface AttemptsPage {
  attempts: AttemptSummary[];
  /** Older attempts exist; ask again with `before` = the oldest attempt number returned. */
  hasMore: boolean;
  /** Highest event id of the task now: open the live stream after it. */
  lastEventId: number;
  /** Markers after the newest attempt (only on the first page). */
  trailing: HistoryMarker[];
}

// ---- diffs
/** A point in the history of a task repository: its HEAD and a commit holding the whole working tree at that moment. */
export interface GitMark { head: string | null; snap: string }
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  deleted: number;
  binary: boolean;
}
export interface DiffSummary {
  files: DiffFile[];
  totals: { files: number; added: number; deleted: number };
  /** Commits the agent made between the two heads (newest first, at most 50). */
  commits: { sha: string; subject: string }[];
}
export interface DiffPatch {
  lines: string[];
  offset: number;
  total: number;
  /** More lines exist after this window. */
  truncated: boolean;
  binary: boolean;
  /** Where the next window starts; null at the end. */
  nextOffset: number | null;
}
export interface AttemptDiff extends DiffSummary {
  attempt: number | 'base';
  /** The attempt was still running when the diff was computed: the right side is the working tree now. */
  live: boolean;
  /** Whether the attempt ended with at least one commit / only uncommitted changes. */
  committed: boolean;
  uncommitted: boolean;
  /** Label of what the right side is compared with, for example "start of attempt 3" or "origin/main". */
  against: string;
}

// ---- screenshots
export interface ShotProblem { kind: 'http' | 'blank' | 'console' | 'request' | 'overlay' | 'unreachable' | 'timeout'; message: string }
export interface Shot {
  id: number;
  taskId: number;
  attempt: number;
  /** Path of the page that was photographed, e.g. `/login`. */
  page: string;
  /** Viewport width: 375 or 1280. */
  width: number;
  httpStatus: number | null;
  title: string | null;
  /** The page loaded without any detected problem. */
  ok: boolean;
  blank: boolean;
  problems: ShotProblem[];
  consoleErrors: string[];
  failedRequests: { url: string; status?: number; error?: string }[];
  bytes: number;
  createdAt: string;
}
export interface AttemptShots {
  attempt: number;
  /** Whether the success check of that attempt passed (null: not run). */
  checkPassed: boolean | null;
  shots: Shot[];
  /** The capture itself failed or could not reach the dev server: why. */
  error: string | null;
}

// ---- environment snapshots
export interface EnvSnapshot {
  id: number;
  projectId: number;
  fingerprint: string;
  bytes: number;
  createdAt: string;
  lastUsedAt: string;
  uses: number;
  /** Current: matches what a new task of the project would ask for. */
  current: boolean;
}
