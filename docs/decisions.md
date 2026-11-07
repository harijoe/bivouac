# Decisions

- **Hono + better-sqlite3 + dockerode**: small, fast, synchronous DB fits a single-node daemon. SSE via Hono streaming.
- **Daemon drives the agent via `docker exec`** into a long-lived task container (supervisor as PID 1 runs the dev server). Keeps git creds/tokens inside the task container only; no docker socket in task containers.
- **Fake claude ships in the task image** (`/opt/bivouac/fake-claude`), selected by `BIVOUAC_CLAUDE_BIN`, so CI and VM e2e exercise the same image without tokens.
- **Task ids are integers** (`t-42`); preview host is `t-<id>.<project>.<domain>`; default domain `<tailscale-ip-dashed>.sslip.io`.
