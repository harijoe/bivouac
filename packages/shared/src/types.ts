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

export interface TaskPort { name: string; port: number; primary: boolean; url: string }
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
