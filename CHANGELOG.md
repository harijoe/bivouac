# Changelog

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
