# Changelog

## 0.4.0

The dashboard is rebuilt, tasks can be created from it, logs are live, and Claude accounts are plural.

### Added
- **New design**: Tailwind v4 and shadcn/ui with the Tiesen theme. Black dark mode by default, light mode available (follows the system on first load, toggle in the header, choice remembered locally). Geist and Geist Mono are served by the dashboard itself, no third-party CDN. Every page was rebuilt with shadcn components (Card, Dialog, Command, Tabs, Sonner toasts, Skeleton loaders) and checked at 375 px in both modes; the old `styles.css` and home-made components are gone.
- **Projects first**: the home page lists projects (one project = one GitHub repository) with running and failing tasks, open pull requests, last activity, the Claude account and a **New task** button. Project page at `/projects/<project>`, task page at `/projects/<project>/<task>`, with a breadcrumb.
- **Create a task from the dashboard**: same parameters as the MCP `create_task` tool (prompt, and name, success command, budget… folded by default), through a REST route that calls the same service (tested to give the same result). The form reminds you that Claude or ChatGPT can do it too.
- **Connect your chat** block on the home page until a chat client has connected, then a link.
- **Repository picker**: searchable list (name and owner, keyboard), most recently pushed first, repositories already added are marked.
- **Live log viewer** per task: sources (setup, dev server, each success check, services such as Postgres), streaming, auto-scroll that pauses when you scroll up with a **Back to live** button, ANSI colours, highlighted errors, optional timestamps, line wrap, search with highlighting, copy and download of the full log, older history loaded on demand, virtualised rendering.
- **Several Claude accounts**: named accounts (subscription or API key) with connection date, expiry and state; add, rename, renew, delete; one default and an account per project (applied from the next agent session, no restart). The existing token becomes the account "Default". The task page shows the account used; expiry and usage-limit errors name the account. The MCP exposes the account name of each project, never a token.

### Changed
- **Settings** reorganised in sections: Claude, Projects (with default limits), Chat connection, Domain, Updates, Access and security (who can sign in, activity), Advanced (collapsed technical information: installation, MCP URL, GitHub App, OAuth allow-list, update source). Dangerous actions (remove a project, switch domain, remove a user) ask for confirmation in a dialog. Every setting shows "Saved" when stored. The former single long page, the "More settings" block and the separate GitHub block no longer exist as such: their content moved to Projects and Advanced.
- The content security policy allows inline *styles* (needed by the UI components); scripts remain restricted to the server's own files.

### Fixed
- Dashboard fonts now load (the font families were declared under the wrong name).

## 0.3.1

Fixes from the first manual test of 0.3.0 on a fresh server, plus tool versions and a way for the agent to stop.

### Fixed
- **Claude sign-in** (blocking): a real code (about 90 characters) was never validated because it was sent together with Enter and the CLI took it for a paste. The code is now typed, then Enter is sent separately. The screen of `claude setup-token` is rebuilt with a terminal emulator before the token is read (the CLI repaints only changed cells, which lost characters of the token), the `sk-ant-oat01-` prefix is checked and a malformed token is never stored. The daemon stores the token itself when the sign-in ends, even if the page was closed. A refused code is reported with the CLI's own message and a **Start over** button; only the output after the last code sent is analysed. The page shows **Verifying the code…** meanwhile.
- **DNS records** for a root domain were shown as `bivouac` and `*.bivouac` (so `bivouac.bivouac.cloud`). They are now relative to the zone of the registrable domain (public suffix list, so `.co.uk` works): `@` and `*` for a root domain, `dev` and `*.dev` for `dev.deslope.com`. Propagation is checked on the domain itself and on a random subdomain.
- **Task titles** no longer keep Markdown (`# Title`, `**bold**`, links, code).

### Added
- **GitHub step**: *Personal account* (default, recommended) or *Organisation* with the consequences spelled out; the organisation name is validated while typing through GitHub's public API (avatar and display name, or "organisation not found").
- **Add a repository with a token** (always visible in the repository list, in the wizard and in settings): link to GitHub's token page, the exact permissions to grant (Contents and Pull requests: read and write, limited to the repository), and a check on save that says which permission is missing.
- **Tool versions**: tasks use the versions the repository declares (`mise.toml`, `.tool-versions`, `.nvmrc`, `.node-version`, `package.json` `engines.node` / `packageManager`, `.python-version`, `go.mod`, `rust-toolchain`), installed without root with mise into a per-project cache (only the first task downloads) and on the `PATH` of setup, dev, success and the agent. `runtime: { node: "26", python: "3.12" }` in `bivouac.yml` forces versions. The agent is told how to install a tool and make it reproducible.
- **`blocked` and `stuck`**: the agent can stop by writing why to `/workspace/.bivouac/blocked.md` (task status `blocked`, reason in the dashboard and `get_task`, resumed by a message or `resume_task`); two consecutive failed checks with the same output and no code change stop the task as `stuck`. Neither is retried.
- **Cost label**: with a Claude subscription the amount is shown as *estimated API equivalent* (`costKind` in the API and `get_task`), not as a spend; the dollar budget stays a consumption safeguard and the setting's help says so.

### Changed
- `image:` in `bivouac.yml` is no longer accepted (it was read but never used): a clear error points to `runtime:` and `setup:`.
- The task image gains mise, `libatomic1` and `xz-utils`; Node 22 stays the default.
- **UI**: every button that waits shows a spinner and an explicit label ("Verifying the code…", "Pushing the branch…", "Checking the token…"…), is disabled meanwhile and cannot be double-clicked; the wizard's organisation choice, DNS table and repository/token forms were rewritten; the blocked and stuck states have their own explanation with the agent's reason; the Claude code field is not emptied silently.

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
