# Changelog

## 0.6.0

Agents get a browser, current library documentation and design skills, and projects can add their own MCP servers and skills (details: `docs/agent-tools.md`).

### Added
- **Playwright MCP** (`@playwright/mcp` 0.0.85, headless, the Chromium already in the image) for every task agent: it can open its own dev server on `localhost` (every port of `ports:`), resize to 375 px and 1280 px, click and read the console. The prompt tells the agent to check every UI change on the running preview before it considers the work finished.
- **Context7 MCP** (`@upstash/context7-mcp` 4.7.0) for up-to-date library docs; works without a key, an administrator can add one in Settings > Context7.
- **`mcp:` in `bivouac.yml`**: your own stdio or HTTP MCP servers, `playwright: false` / `context7: false` to turn the defaults off. Secrets are entered by an administrator in the project settings (encrypted, write-only, masked in the history, passed to the agent as environment variables, never in the generated config), and a server that asks for secrets must be approved in the dashboard for its exact definition.
- **Skills**: `frontend-design` and `webapp-testing` (anthropics/skills, Apache-2.0, pinned commit) in the task image; **`skills:` in `bivouac.yml`** installs catalogue skills (first entry: `taste-skill`, MIT, pinned) from a cache on the server. The repository's own `.claude/skills` keeps working. Catalogue skills lose their `hooks:` block: taste-skill's 600 s Stop gate cannot block or extend an attempt; the success check is unchanged.
- The task page ("Agent tools") and `get_task` (`tooling`) show which MCP servers (with the status the CLI reported) and skills the agent had.

### Image
- Task image: about +84 MB on disk, +12 MB compressed (628 MB to 640 MB) for the two MCP servers and the skills; Chromium was already there. The two default MCP servers add about 700 cached input tokens per request (measured); switch them off for tasks that never touch a UI.

## 0.5.1

Fixes from a full review of 0.5.0: two security issues in what an agent can make the host do, a more reliable update and restart path, and many smaller fixes (details in `docs/review-v0.5.md`).

### Security
- The agent can no longer make bivouac run commands through the repository's `.git/config` (`core.fsmonitor`, clean filters, `textconv`, partial-clone commands) or send the push token to another server (`remote.origin.url`, `pushurl`, `insteadOf`): host-side git now works from a reduced configuration, a clean environment and the project's own URL.
- Reading and writing files of a task workspace from the executor refuses symbolic links planted by the agent.
- A share link's cookie only opens the task it was issued for (it kept working after an alias was moved to another task). Encoded separators (`%2f`, `%5c`, `\`) never match an alias public path.
- The update status file is written without following links in a directory the web service owns. The sign-in redirect refuses `/\host`. Only an administrator can revoke an MCP client. Task containers have a process limit and no swap.

### Fixed
- Restart preview (button, MCP tool, `touch restart.req`) did nothing the first time.
- Members of an allowed GitHub organisation or team could sign in but were sent back to the login page.
- `install.sh` used to update now rolls back to the previous configuration when the new version is unhealthy, and a failed start (firewall, compose) rolls back instead of leaving bivouac stopped; a failed backup stops the update without changing anything.
- `get_project_context` showed stale data for tasks with more than 5000 events and was slow with many tasks that have pull requests; its argument errors are now clear.
- Deleting a task warns about commits made after a first push, and Open PR pushes again when the branch has new commits.
- Task creation rejects invalid limits (negative or non-numeric tokens, fractional or huge attempts); `resume_task` on a running task no longer changes its limits before failing; a project named like a number can be addressed; `get_attempt_diff` against the base branch lists the commits; `send_instruction` on a task that ran out of budget says so.
- A never-expiring share link no longer shows "expired" after 30 days of one visitor's cookie.
- Renaming a task returns to its Settings tab; Sign out, the task card's Open preview and confirmation dialogs show a pending state and cannot be repeated or dismissed while they wait.
- Two tasks finishing `setup` at the same time no longer collide on the snapshot file; multibyte characters are no longer corrupted at chunk boundaries in agent output and diffs; timers cannot crash the daemon with an unhandled rejection.

## 0.5.0

Proof, diffs, a preview you can rely on, and fast task start-up.

### Added
- **Screenshots after each attempt**: when the dev server answers, bivouac photographs the pages listed under `preview.screenshots` in `bivouac.yml` (default `/`) at 375 px and 1280 px, with headless Chromium inside the task container (direct access, the preview's access check is not involved). Each shot carries the HTTP status, the page title, browser console errors and failed requests; an error page, an error overlay (Vite, Next) or a blank page is flagged. Dashboard: a gallery in each attempt (thumbnails, full-size dialog, comparison with the previous attempt, a note when the success check failed). MCP: `get_task` returns the last attempt's screenshots as images (compressed, at most 4) with their errors, and the new tool `get_attempt_screenshots` returns those of any attempt (`variant: full` for full size). Storage is bounded (the newest 12 attempts per task and 60 MB, removed with the task); a failed capture is logged and shown, never fails an attempt. The task image now ships Chromium (about 400 MB more).
- **Diff per attempt**: the start and end state of every attempt are recorded (commit plus a snapshot of the working tree, so uncommitted changes count). The attempt section lists changed files with `+N −M`, a collapsible coloured diff per file, long diffs paged ("Show next lines"), and a **Changes** tab compares the whole task with its base branch. MCP: `get_task` summarises each attempt's changes; `get_attempt_diff` reads the file list or the patch, paged.
- **Reliable preview**: the supervisor probes the dev server (`preview.health: { port, path }` in `bivouac.yml`), restarts it when it dies or stops answering with a growing delay (1 s … 60 s) and gives up after 8 restarts in a row. The task page shows "Preview unavailable since …", the last cause, a link to the log and a **Restart preview** button (also the MCP tool `restart_preview`). Stops, restarts, recovery and giving up are in the history and told to the agent in its next prompt. The agent can restart it with `touch /workspace/.bivouac/restart.req`.
- **Project alias**: a stable host `<alias>.<domain>` (for example `app.dev.example.com`) that you point at one task of the project from the dashboard or with the MCP tool `set_project_alias_task`, for OAuth redirect URIs and webhooks of the app under test. It uses the same access check as the task's own URL; administrators can list **public paths** (for example `/api/webhooks/`) that skip it so that third-party callers can reach them. Needs the wildcard DNS record you already have for previews.
- **Share links**: expired and revoked links are told apart on the page the visitor sees; the owner sees expired and revoked links in a folded list.
- **Faster task start-up with environment snapshots**: after a successful `setup`, bivouac keeps what `setup` installed and git ignores (`node_modules`, virtualenvs…) as an archive keyed by a fingerprint of the lock files, the `setup` command, the tool versions and the task image. A new task of the project with the same fingerprint unpacks it before running `setup`, which still runs and stays correct if the snapshot is stale or damaged (a snapshot that makes setup fail is discarded and setup runs again from scratch). At most 3 snapshots are kept per project (least recently used removed), secrets (`.env`, keys) and logs are never included. Settings > Projects shows the snapshot (date, size, fingerprint) and a **Rebuild** button. Measured on a Node + pnpm (about 800 packages) + Postgres example: agent ready after 5.0 s instead of 16 s, preview available after 6.3 s instead of 16.7 s (see `docs/bench-snapshot-v0.5.json`).

### Changed
- The dev server's health is polled twice a second until it is up (the preview is reported as soon as it answers).

## 0.4.1

Feedback from a real long task (about thirty attempts, a Postgres database with 100 000 rows).

### Added
- **Task history by attempt**: the Activity tab groups the history per attempt, the most recent first. Each attempt is a collapsible section whose header shows its number, start time, duration, cost (an API-equivalent estimate with a subscription), the result of its success check and the beginning of the agent's last message. The running or latest attempt is open, the others folded; inside, events stay chronological with tool calls folded. Instructions (dashboard or MCP), stops, blocked / stuck / budget / out-of-attempts states, resumptions and limit changes appear as markers between attempts. Filters (agent messages, checks, tool calls, instructions), search with highlighting that opens the matching attempts, a copyable link per attempt (`#attempt-12`), older attempts loaded on demand (15 at a time, events only when an attempt is opened), and live events that land in the open attempt without moving the page. The page no longer replays the whole history when it opens.
- **`get_task` lists attempts** (newest first, paginated with `attempts_limit` / `attempts_before`, same facts as the header and what triggered each).
- **Change the limits of an existing task**: budget, maximum attempts and success command, from the task page (Settings tab) and through the new MCP tool `update_task` or the new parameters of `resume_task`. They apply from the next attempt; the change is recorded in the history. A task stopped on its budget cannot resume without a higher limit: the dashboard asks for it in a dialog, and the API / MCP answer with a clear message (values are totals, not increments). A task out of attempts is offered more.
- **Memory and CPU per service** in `bivouac.yml` were already accepted; the default memory is now **1 GB** (it was 512 MB), applied when the container is created and also to existing containers when the value changes. Services run without swap.
- **A service killed for lack of memory is reported**: in the task history and in the service's log, with the limit in force and how to raise it; bivouac starts it again (up to 5 times) and tells the agent in its next prompt.

### Fixed
- **`push_branch` runs without the repository's git hooks** (`--no-verify`): a `.githooks/pre-push` calling `pnpm` no longer blocks the push (the repository's checks run in the task, as the success command). The error message only mentions the GitHub App's permissions on a real authorization error (403); other failures say what actually happened.
- `get_task` read the *oldest* 5000 events of a task, so a long task showed stale messages; it now reads the latest.
- Resuming a stopped task no longer resets its attempt limit to "attempts made + 10" when it still has attempts left.

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
