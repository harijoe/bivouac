# Decisions

- **Hono + better-sqlite3 + dockerode**: small, fast, synchronous DB fits a single-node daemon. SSE via Hono streaming.
- **Daemon drives the agent via `docker exec`** into a long-lived task container (supervisor as PID 1 runs the dev server). Keeps git creds/tokens inside the task container only; no docker socket in task containers.
- **Fake claude ships in the task image** (`/opt/bivouac/fake-claude`), selected by `BIVOUAC_CLAUDE_BIN`, so CI and VM e2e exercise the same image without tokens.
- **Task ids are integers** (`t-42`); preview host is `t-<id>.<project>.<domain>`; default domain `<tailscale-ip-dashed>.sslip.io`.
- **Git runs on the host (daemon), not in the task container.** The daemon clones/pushes with the project token injected as an HTTP header; the token never enters a task container or `.git/config`. The agent commits locally; the user pushes via the dashboard.
- **Traefik joins each task's private network** (instead of tasks joining a shared one), so tasks can't reach each other's dev servers; the preview is routed per task.
- **Instruction injection uses a queue + `--resume`** (not `--input-format stream-json`): simple and deterministic; instructions land at the next iteration boundary.
- **Token budget counts input + output + cache-creation tokens** (cache reads excluded). Cost budget is also enforced by the CLI itself via `--max-budget-usd <remaining>`.
