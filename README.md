# ⛺ bivouac

**bivouac runs several Claude Code agents in parallel on one VPS — each in its own container, each with a live preview URL of the app it is building — and gives you a web dashboard to follow their progress, tokens and cost.**
You give an agent a prompt, a "success command" (e.g. `pnpm test && pnpm build`) and a budget; bivouac runs the official `claude` CLI, checks the result itself, and sends the agent back to work with the failure output until the check passes or the budget is spent.
Everything is private by default: the dashboard and the previews are only reachable through your [Tailscale](https://tailscale.com) network.

![bivouac dashboard](docs/screenshots/task.png)

<p align="center"><img src="docs/screenshots/project.png" alt="project tasks" width="48%"> <img src="docs/screenshots/mobile.png" alt="mobile view" width="22%"></p>

> **About Claude subscriptions.** bivouac does not talk to the Anthropic API itself and does not reimplement any login: it launches the **official `claude` CLI** inside each task container. If you authenticate with a Claude subscription (`claude setup-token`), the consumption counts as normal Claude Code usage on that subscription and is subject to its limits, and Anthropic's usage policy may change over time. That is why bivouac also supports a plain `ANTHROPIC_API_KEY` (pay-as-you-go) — use whichever fits your plan and Anthropic's current terms.

## Contents
[Prerequisites](#prerequisites) · [Install](#install) · [First project and task](#first-project-and-task) · [`bivouac.yml`](#bivouacyml) · [Custom domain and TLS](#custom-domain-and-tls) · [Security](#security) · [Update / uninstall](#update-and-uninstall) · [Troubleshooting](#troubleshooting) · [Development](#development) · [License](#license)

## Prerequisites

| What | Details |
| --- | --- |
| A VPS | Ubuntu **24.04** (22.04 works too), x86-64 or arm64. Recommended: **4 vCPU / 8 GB RAM / 80 GB disk** for 3–4 parallel tasks (minimum 2 vCPU / 4 GB for one or two). Root (sudo) access. |
| Tailscale | A free account at <https://login.tailscale.com>, and Tailscale installed on the devices you will browse from (Mac, phone…). |
| Claude access | Either a Claude subscription (you will create a long-lived token with `claude setup-token`) **or** an Anthropic API key. |
| GitHub token | A fine-grained personal access token limited to the repositories you want agents to work on (see below). |

### Getting each credential

- **Tailscale auth key** (optional but recommended for unattended installs): <https://login.tailscale.com/admin/settings/keys> → *Generate auth key*. Without it, the installer prints a login URL instead.
- **Claude token**: on any machine where Claude Code is installed and logged in, run `claude setup-token` and copy the `sk-ant-oat01-…` token it prints. For an API key, create one at <https://console.anthropic.com/settings/keys> (`sk-ant-api…`).
- **GitHub token**: <https://github.com/settings/personal-access-tokens/new> → *Only select repositories* → pick your project repo(s) → repository permissions **Contents: Read and write** and **Pull requests: Read and write** (Metadata read is implied). Give it a short expiry.

## Install

On a fresh Ubuntu VPS, as a user with sudo. First (optionally) export your credentials so the installer does not need to ask:

```bash
export TS_AUTHKEY=tskey-auth-xxxxxxxx              # optional: otherwise a login URL is printed
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxx   # or: export ANTHROPIC_API_KEY=sk-ant-api03-xxxx
```

Then run the installer:

<!-- e2e:install:start -->
```bash
curl -fsSL https://raw.githubusercontent.com/harijoe/bivouac/main/install.sh | sudo -E bash
```
<!-- e2e:install:end -->

The installer is idempotent. It: installs Docker (official repository) and Tailscale, joins your tailnet, creates `/etc/bivouac` (config, `600`) and `/var/lib/bivouac` (data), pulls the images for one pinned version, starts Traefik and the daemon through the `bivouac.service` systemd unit, waits for the health check, and prints:

```
  ⛺ bivouac 0.1.0 is running.
  Dashboard:     http://100.64.1.2:3000
  Access token:  3f9c…
  Previews:      http://t-<id>.<project>.100-64-1-2.sslip.io
```

If you run it from a terminal without exporting anything, it asks for the Tailscale key, the Claude token and an optional domain. Useful variables: `TS_AUTHKEY`, `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, `BIVOUAC_DOMAIN`, `BIVOUAC_TLS`, `BIVOUAC_VERSION`, `BIVOUAC_NONINTERACTIVE=1` (see the header of [`install.sh`](install.sh)).

Open the dashboard URL from any device on your tailnet (`http://<tailscale-ip>:3000`) and paste the access token. If you did not provide Claude credentials, the dashboard shows a banner to add them.

## First project and task

1. **Add a project** (dashboard → *+ Add project*): the git URL of your repo and the fine-grained GitHub token. bivouac checks that it can read the repository and detects its default branch.
2. Add a [`bivouac.yml`](#bivouacyml) at the root of the repo (or set the same keys with the *Config* button).
3. **New task**: write the prompt, optionally a success command and budgets, and press *Start task*.
4. Watch it live: agent messages and tool calls (collapsible), the current iteration, tokens, estimated cost, the output of the last check, the dev-server logs, and a link to `http://t-<id>.<project>.<domain>` where the app runs in dev mode and updates as the agent edits files.
5. While it works you can **send an instruction** (applied at the next iteration), **stop** it, **resume** it, **push** the branch (`agent/t-<id>-<slug>`) and **open a pull request**. Deleting a task removes its container and folder (with a confirmation if commits are not pushed).

Statuses: `queued → starting → running → checking → succeeded`, or `failed`, `budget_exceeded`, `max_iterations`, `stopped`.

Under the hood, for each task the daemon: clones your repo on the host (the GitHub token never enters the container), creates the branch, starts a non-root container, runs `setup`, starts the dev server under a supervisor (restarted if it crashes), then loops: `claude -p … --output-format stream-json --verbose --dangerously-skip-permissions` → run the success command → if it fails, `claude --resume <session>` with the (truncated) failure output. The cost cap is also passed to the CLI with `--max-budget-usd`.

## `bivouac.yml`

```yaml
setup: pnpm install            # run once per task workspace
dev:
  command: pnpm dev --host 0.0.0.0
  port: 5173                   # port the preview is routed to
success: pnpm test && pnpm build
limits:
  cpus: 2
  memory: 4g
budget:
  max_iterations: 10
  max_cost_usd: 20
  # max_tokens: 5000000        # input + output + cache-creation tokens
```

Precedence: built-in defaults < `bivouac.yml` in the repo < overrides saved from the dashboard < values given when creating the task. Task containers are built from the bivouac task image (Debian, git, Node 22, pnpm, the `claude` CLI); the optional `image:` key is reserved for derived images (`FROM ghcr.io/harijoe/bivouac-task`).

**Dev servers must accept the preview hostname.** Vite blocks unknown `Host` headers: set `server.allowedHosts: true` in `vite.config.ts` (see [`examples/vite-app`](examples/vite-app)). Next.js/webpack-dev-server have equivalents (`allowedDevOrigins`, `allowedHosts: 'all'`). Bind to `0.0.0.0`.

## Custom domain and TLS

By default previews use [sslip.io](https://sslip.io): `t-42.my-app.100-64-1-2.sslip.io` resolves to `100.64.1.2` (your VPS' Tailscale IP) with no DNS setup, and works from any device on the tailnet.

To use your own domain: create a wildcard DNS record `*.preview.example.com → <Tailscale IP of the VPS>` (an `A` record to a private `100.x` address is fine) and install with `BIVOUAC_DOMAIN=preview.example.com`. Previews become `http://t-42.my-app.preview.example.com`.

For HTTPS with Let's Encrypt (DNS-01 challenge through Cloudflare, so nothing needs to be exposed publicly), put the domain on Cloudflare and use a token with *Zone → DNS → Edit*:

```bash
export BIVOUAC_DOMAIN=preview.example.com BIVOUAC_TLS=cloudflare
export CF_DNS_API_TOKEN=xxxx ACME_EMAIL=you@example.com
curl -fsSL https://raw.githubusercontent.com/harijoe/bivouac/main/install.sh | sudo -E bash
```

Traefik requests a certificate per preview host on first use (rate limits of Let's Encrypt apply).

*Public previews:* creating a task with *Public preview* enables HTTP basic auth (user `preview`, a generated password shown once) on its router. It only helps if you also make the VPS reachable from the internet, which the default install deliberately is not.

## Security

**Network.** The daemon (dashboard + API) and Traefik listen **only on the VPS' Tailscale IP**; nothing is published on the public interface. The API additionally requires the access token (stored in `/etc/bivouac/bivouac.env`, mode 600). Secrets (GitHub tokens, Claude credentials entered in the dashboard) are encrypted at rest in SQLite with AES-256-GCM; the key is `/var/lib/bivouac/secret.key` (mode 600), outside the database.

**One-way Tailscale ACL.** Your devices should reach the VPS; the VPS (and so any agent that escaped its container) should reach nobody. Tag the VPS `tag:bivouac` (use an auth key created with that tag, or `tailscale up --advertise-tags=tag:bivouac`) and paste this in <https://login.tailscale.com/admin/acls> (adapt the `tagOwners` / your own rules):

```json
{
  "tagOwners": { "tag:bivouac": ["autogroup:admin"] },
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:bivouac:*"] }
  ]
}
```

Tailscale ACLs are deny-by-default and stateful: replies to your connections work, but with no rule whose `src` is `tag:bivouac`, the VPS cannot open connections to any of your devices. (If you already have other rules, keep them and just make sure none has `tag:bivouac` as a source.)

**Tokens.** Use fine-grained GitHub tokens limited to the project repositories (Contents + Pull requests only). The GitHub token stays in the daemon: clone and push run on the host and the token is never put in a task container or in `.git/config`. The Claude credential **is** exposed to the agent process (it needs it to run); use a dedicated token/key with a spend limit.

**What an agent can and cannot reach.** Each task runs as an unprivileged user (`node`, uid 1000) in its own container and its own Docker network, with `no-new-privileges`, CPU and memory limits, and **no Docker socket**. It can: read/write its workspace, use the internet (including your Claude token), reach the host's Docker bridge gateway, and run anything inside the container (`--dangerously-skip-permissions`). It cannot: see other tasks' files or dev servers (separate networks and workspaces), control Docker, read the GitHub token or the bivouac database. Treat the VPS as dedicated to this purpose: the daemon container does mount the Docker socket (it must manage containers), which is root-equivalent on the host — that is why the dashboard is tailnet-only and token-protected.

## Update and uninstall

- **Update**: re-run the install command (optionally with `BIVOUAC_VERSION=x.y.z`). Settings and data are kept; running task containers are left alone, interrupted runs are marked `stopped` and can be resumed.
- **Uninstall**: `sudo bash /opt/bivouac/uninstall.sh` removes the service, containers and networks and keeps `/var/lib/bivouac`; add `--purge` to delete all data and configuration. Docker and Tailscale are not removed.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Installer: `Unsupported OS` | Use Ubuntu 22.04/24.04. |
| Installer waits at Tailscale login | Open the printed URL, or pass `TS_AUTHKEY`. |
| Installer: `Cannot pull …` | Images are private or the version does not exist: check `BIVOUAC_VERSION`, or set `BIVOUAC_REGISTRY_USER` / `BIVOUAC_REGISTRY_TOKEN`. |
| Dashboard unreachable | Your device must be on the tailnet; use the **Tailscale IP** of the VPS (`tailscale ip -4` on the VPS). `docker logs bivouac-daemon`. |
| Preview shows `404 page not found` | The task container is not up yet, or `dev.port` in `bivouac.yml` does not match the port the dev server listens on. See the *Dev server logs* tab. |
| Preview shows `Blocked request. This host is not allowed` | Vite: set `server.allowedHosts: true`. |
| Preview hostname does not resolve | sslip.io needs public DNS; or use your own wildcard record. Test: `dig +short t-1.x.100-64-1-2.sslip.io`. |
| Task `failed` right away with an authentication error | Add/replace the Claude token in the dashboard or `/etc/bivouac/bivouac.env` (then `systemctl restart bivouac`). |
| Task `failed` at `setup` | The `setup` command exited non-zero; open the first events of the task for its output. |
| `budget_exceeded` / `max_iterations` | Raise the limit (`PATCH /api/tasks/<id>`) and press *Resume*. |
| Everything is slow / OOM | Lower `limits.memory`/`BIVOUAC_MAX_PARALLEL`, or use a bigger VPS. |

Logs: `docker logs -f bivouac-daemon`, `docker logs bivouac-traefik`; dev server log: `/var/lib/bivouac/projects/<project>/tasks/t-<id>/workspace/.bivouac/dev.log`.

## Development

```bash
pnpm install && pnpm build
pnpm lint && pnpm typecheck && pnpm test       # unit tests (fake claude, no Docker needed)
pnpm test:integration                           # real Docker + Traefik + fake claude, uses ports 8088 and the prefix bivouac-dev-
scripts/e2e-fresh-vps.sh                        # fresh Hetzner VM, runs this README's install command (needs HCLOUD_TOKEN)
scripts/e2e-fresh-vps.sh --real                 # same with the real claude CLI (small budget)
```

Layout: `packages/shared` (types, stream-json parser, config), `packages/daemon` (Hono API, SQLite, runner, dockerode), `packages/dashboard` (React + Vite), `packages/task-image` (task Dockerfile, supervisor, fake `claude` used in tests). Design decisions are in [`docs/decisions.md`](docs/decisions.md). The fake `claude` (`packages/task-image/fake-claude/claude`) is steered by markers in the prompt: `FAKE_SCENARIO=succeed|fail-then-succeed|always-fail`, `FAKE_COST=<usd>`, `FAKE_DELAY=<ms>`, `FAKE_CRASH=1`.

## License

MIT — see [LICENSE](LICENSE).
