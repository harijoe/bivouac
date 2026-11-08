# Changelog

## 0.3.0

### Added
- **Update from the dashboard.** bivouac checks GitHub releases daily (and on demand); administrators see a banner with the release notes and an **Update** button. The update backs up the database and configuration (3 kept), downloads, reconfigures, restarts, checks health, and **rolls back automatically** (images, configuration, database) with the reason shown in the dashboard. Progress is shown step by step; results are in the activity log. Updating while tasks run is scheduled for when none runs (new tasks are refused with a clear message meanwhile), or done now by stopping them (resumable). Optional automatic nightly updates.
- **Several ports per project** (`ports:` in `bivouac.yml`): `<task>.<project>.<domain>` for the main one, `<port>.<task>.<project>.<domain>` for the others, with the same protection; share links cover all ports. The old `dev.port` form still works.
- **Services** (`services:` in `bivouac.yml`): Postgres, Redis… one instance per task on its private network, reachable by name, with CPU/memory limits and an optional volume, removed with the task.
- **The agent can declare ports and services** by editing `bivouac.yml`: it is re-read at each agent session; an invalid file keeps the last valid configuration and reports the error.
- **Network isolation**: a firewall installed by the installer (removed by the uninstaller) keeps task containers away from everything on the server, from the `web`/`executor` containers and from the cloud metadata address, without affecting Internet access.
- **MCP**: `get_project_context` (compact snapshot to plan the next mission), `read_project_file`, and the `plan_next_mission` prompt.

### Changed
- `install.sh` and the dashboard updater share one script (`apply.sh`); re-running the installer now also backs up and rolls back.
- Dependencies: `@hono/node-server` 2.1.3 and `uuid` >= 11.1.1 (security advisories).

### Notes
- Upgrading from 0.2.x requires the installer over SSH (0.2.x cannot update itself): `curl -fsSL https://raw.githubusercontent.com/harijoe/bivouac/main/install.sh | sudo bash`. Later versions update from the dashboard.
- Running agents are not re-attached across an update (stop and resume instead).

## 0.2.0

A different way to use bivouac: install, click through a short setup page, then work from a Claude or ChatGPT conversation.

### Added
- **MCP server** (`/mcp`, streamable HTTP, OAuth 2.1 with PKCE, dynamic client registration, rotating refresh tokens) with 11 tools: `list_projects`, `list_tasks`, `get_task`, `create_task`, `send_instruction`, `stop_task`, `resume_task`, `create_share_link`, `revoke_share_link`, `push_branch`, `open_pr`.
- **Setup page** (domain, GitHub App, repositories, Claude, chat) opened from a one-time link with QR code; `sudo bivouac reset-admin` for recovery.
- **Sign in with GitHub** through a private GitHub App created for each instance; allow-list by numeric GitHub id, organisation or team.
- **Connect Claude from the dashboard** (`claude setup-token` in a throwaway container), expiry shown, renewable; API key alternative.
- Automatic HTTPS (Let's Encrypt, HTTP-01) on `<ip>.sslip.io` or your own domain, with a DNS check in the wizard.
- Task names (unique per project) used in preview URLs `<task>.<project>.<domain>`; live rename without restart.
- Protected previews: one-time owner tickets, share links (1 h / 24 h / 7 d / none) with revocation.
- Audit log, rate limiting, strict CSP, per-repository GitHub installation tokens.
- New mobile-first dashboard (light and dark); it follows, stops and configures; tasks are created from the chat.

### Changed
- Architecture: `web` (public, no Docker socket) and `executor` (Docker access, internal only).
- Traefik routes come from an HTTP provider fed by the database instead of Docker labels.
- The installer asks nothing and installs `bivouac` CLI helpers.

### Removed
- Tailscale (installer, listening address, README ACL), the access token login and per-task basic auth.

### Upgrading from 0.1.x
Run the install command again. The database is migrated (existing tasks are named `t-<id>`), task containers are recreated on resume, and the setup link finishes the new GitHub connection.

## 0.1.0
First release: Tailscale-private dashboard, parallel Claude Code tasks with previews and a success loop.
