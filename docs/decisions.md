# Decisions

- **Hono + better-sqlite3 + dockerode**: small, fast, synchronous DB fits a single-node daemon. SSE via Hono streaming.
- **Daemon drives the agent via `docker exec`** into a long-lived task container (supervisor as PID 1 runs the dev server). Keeps git creds/tokens inside the task container only; no docker socket in task containers.
- **Fake claude ships in the task image** (`/opt/bivouac/fake-claude`), selected by `BIVOUAC_CLAUDE_BIN`, so CI and VM e2e exercise the same image without tokens.
- **Task ids are integers** (`t-42`); preview host is `t-<id>.<project>.<domain>`; default domain `<tailscale-ip-dashed>.sslip.io`.
- **Git runs on the host (daemon), not in the task container.** The daemon clones/pushes with the project token injected as an HTTP header; the token never enters a task container or `.git/config`. The agent commits locally; the user pushes via the dashboard.
- **Traefik joins each task's private network** (instead of tasks joining a shared one), so tasks can't reach each other's dev servers; the preview is routed per task.
- **Instruction injection uses a queue + `--resume`** (not `--input-format stream-json`): simple and deterministic; instructions land at the next iteration boundary.
- **Token budget counts input + output + cache-creation tokens** (cache reads excluded). Cost budget is also enforced by the CLI itself via `--max-budget-usd <remaining>`.

## v0.2

- **web / executor split.** One image, two services. `web` (public, non-root, no Docker socket) serves the dashboard, API, MCP and OAuth. `executor` (root, Docker socket) is reachable only from `web` on an internal Docker network, with a shared secret, and accepts only: prepare repo, start/stop/destroy/exec in *task containers it names itself*, read/write a few workspace files, push, and `claude setup-token` sessions. It never takes images, mounts, networks or labels from its caller.
- **Routes come from the database, not Docker labels.** Traefik uses the HTTP provider (`web:3001/internal/traefik`, polled every second). A rename is a DB update, live within ~1 s with no container restart. The internal listener (3001) is never routed by Traefik.
- **Preview access = forwardAuth to `web`.** Entry by one-time ticket (owner) or share token in the URL swaps for a host-bound, HMAC-signed cookie; the 302 drops the secret from the URL. forwardAuth returns the remaining `Cookie` header and Traefik's `authResponseHeaders: Cookie` replaces the request header, so the app never sees `bv_preview`. Share cookies are re-checked against the DB (revocation is immediate).
- **Identity = the instance's own GitHub App** (manifest flow). Login uses its user authorization; git uses installation tokens narrowed to one repo and to `read`/`write` permission sets, cached until 5 min before expiry. Allow-list stores numeric ids; orgs/teams are checked live with the installation token.
- **MCP is stateless** (new server + transport per request, JSON responses): nothing to lose between requests or on restart. OAuth server written in-house (small, fully tested): DCR, S256-only PKCE, rotating refresh tokens with reuse detection, hashed storage.
- **Setup link = hashed code + signed cookie.** Valid until the GitHub step creates the admin, then closed. `bivouac reset-admin` creates a new one; changing the domain does the same because the GitHub App must be recreated.
- **Task name is the preview label**; the branch stays `agent/t-<id>-<name>` so a rename or name reuse never touches git history.
- **Certificates per host via HTTP-01**, on demand (no DNS API needed). The sslip.io/own-domain wildcard is *not* a wildcard certificate.
- **UI is English only for now**; strings are plain JSX, easy to extract later.
