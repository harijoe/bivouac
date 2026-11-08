# v0.3 final pass: simplification, bugs, security

## Simplification
- **One deployment implementation.** `install.sh` used to generate compose, systemd unit and the `bivouac` command itself; that logic now lives only in `apply.sh`, which `install.sh` and the dashboard updater both run (-120 lines in `install.sh`).
- `scripts/e2e-fresh-vps.sh` and `scripts/e2e-v03.sh` share the Hetzner VM lifecycle in `scripts/lib-hcloud.sh` (-47 lines in the former).
- `TaskManager.readRepoConfig` and `loadConfig` were two parsers of the same file; `resume` keeps the side-effect-free one, runs use `loadConfig`.
- `server.ts` and the settings API read the version from the config (one source) instead of a second `process.env` read; a mismatch made the dashboard reload in a loop during the screenshots.
- No dead code found by `tsc --noUnusedLocals/--noUnusedParameters`.

## Bugs found and fixed
| Found by | Problem | Fix |
|---|---|---|
| e2e (rollback) | `apply.sh update` changed the version in the env file *before* the backup: the backup held the new configuration, so the rollback restarted the broken version. | Back up first, then switch the version. |
| e2e (rollback) | `render` exported the env-file values into the script's environment, where `docker compose` gives them priority over `.env`: after restoring the old file, compose still used the new image. | `load_env` reloads after every restore. |
| e2e | The `update_succeeded` audit entry was only written by the 10 s scheduler tick, so a client reading the audit right after the update could miss it. | Written as soon as the status is read (+ unit test). |
| e2e | The test client never exited (open MCP stream) and an `ssh … &` held its channel: both hung runs. | `process.exit`, `systemd-run`. |
| unit test | A task left in `running` by a crash could not be stopped (nothing active, status not `queued`). | `stop` now also settles `starting/running/checking` orphans. |
| UI demo | Dashboard reloaded in a loop when the session version and the update-status version came from two sources. | Single source (config). |
| review | A task network created by 0.2 has no predictable bridge name and would escape the firewall after an update. | `start` recreates such a network (workspace untouched). |
| review | `get_project_context` printed the effective `bivouac.yml`, including service `env` values (database passwords). | Values replaced by `[hidden]` (+ test). |
| review | A stale `update-status.json` in `running` (machine died mid-update) would block new tasks forever. | A `running` status older than 20 minutes is reported as failed. |

## Security review
Surfaces examined: setup, GitHub sign-in, OAuth/MCP, previews and share links (now several hosts per task), API, updater, task isolation, secrets, command injection, headers/cookies, dependencies.

- **Updater.** Only administrators reach `/api/update/*` (tested for every verb). The executor accepts a semver only (never an image name or command), derives the registry from its own image, and refuses a second concurrent update. The updater is privileged, but the executor already holds the Docker socket: no new privilege level, only a fixed-shape operation (see decisions.md). Backups are `0700`, root-owned (they contain the database and key).
- **Injection.** `bivouac.yml` is written by an agent, so it is validated twice (web, then again in the executor): images must match a strict reference pattern (no flags, no spaces), env names are identifiers, volumes are absolute paths without `..`, names are DNS labels, counts are capped (tests for each). Values reach Docker as structured API fields, never through a shell. Task names, branches and paths in the context tools are validated (`..`, absolute paths, leading `-`, refs with `@{}` refused). Version strings in `apply.sh` are matched against a semver pattern.
- **Isolation (verified by the e2e on a real VM).** Task → host SSH, host ports, the Docker gateway, the public address, `web`, `executor`, Traefik's API ports and the metadata address are all unreachable; Internet and the task's own sidecars work; one task cannot reach another task's Postgres and cannot see its data.
- **Secrets.** Context tools exclude secret paths and git-ignored files, mask token-like strings and `password=…` values in documents, prompts, agent messages and check output, and hide service env values. Task containers never receive tokens (unchanged).
- **Cookies/headers.** Unchanged and still tested; share/ticket cookies stay host-bound, so each port host gets its own.
- **Dependencies.** `pnpm audit --prod`: two moderate advisories (`uuid` via dockerode, `@hono/node-server` `serveStatic` double decoding) fixed by an override and an upgrade to `@hono/node-server` 2.1.3; all tests pass. No known vulnerability remains.

## Remaining, with the reason
- **Secrets in non-secret files.** A short password in a committed file with an ordinary name (for example `config.yml`) is only masked when it matches a pattern (12+ characters after a key such as `password:`). The tool shows the user's own repository to the user's own assistant; a stricter filter would hide useful content. Keep secrets in `.env` or a secret manager.
- **Sidecars are not supervised.** A crashed service is not restarted until the next agent session (`start` revives stopped ones). Declared as acceptable: tasks are short-lived.
- **Sidecar images come from the repository.** An agent can pull any public image as a service. They run unprivileged on the task's private network with CPU/memory/pids limits and the same firewall; a private registry is not supported.
- **Firewall assumes Docker's iptables mode.** Hosts using only nftables rules with Docker's `iptables: false` are unsupported (the installer's target, Ubuntu with Docker defaults, is covered by the e2e).
- **DNS to the host's own address.** If a host resolver listens on a task network's gateway address, tasks lose DNS (the firewall blocks it); Docker's embedded DNS forwards to external resolvers, which is the default.
- **Running agents are not re-attached after a restart** (see decisions.md): stop and resume is the supported path.
- **Not testable alone** (listed in PROGRESS.md): real GitHub App/OAuth with Claude.ai/ChatGPT clients.
