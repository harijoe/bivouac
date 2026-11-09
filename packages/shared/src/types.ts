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
  createdAt: string;
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
