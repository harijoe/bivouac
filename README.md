# bivouac

**Run several Claude Code agents in parallel on your own server, and drive them from a Claude or ChatGPT conversation.**

Each agent works in its own container, on its own git branch, and gets a live preview URL of the app it is building. You install bivouac with one command, click through a short setup page, add it as a connector in your chat app, and then just ask: *“Using bivouac, add a dark mode to my-app.”* The dashboard is there to follow, stop and configure.

<p align="center">
  <img src="docs/screenshots/home-mobile.png" alt="Tasks on a phone" width="260">
  &nbsp;
  <img src="docs/screenshots/task-mobile.png" alt="A task: progress, preview, share links" width="260">
</p>
<p align="center"><img src="docs/screenshots/home-desktop.png" alt="Dashboard on a desktop browser" width="640"></p>

## Contents

[What you need](#what-you-need) · [Install](#install) · [The setup page](#the-setup-page) · [Connect your chat](#connect-your-chat) · [Daily use](#daily-use) · [Sharing a preview](#sharing-a-preview) · [Project configuration](#project-configuration-bivouacyml) · [Your own domain](#your-own-domain) · [Security model](#security-model) · [Update and uninstall](#update-and-uninstall) · [Troubleshooting](#troubleshooting) · [Claude subscriptions](#about-claude-subscriptions) · [Development](#development)

## What you need

- A server (VPS) with a **fresh Ubuntu 24.04** (22.04 also works), 2 vCPU and 4 GB of RAM at least; 4 vCPU / 8 GB is comfortable for several agents. Any provider works.
- **Ports 80 and 443 reachable from the internet** (open them in your provider's firewall). bivouac gets a free HTTPS certificate from Let's Encrypt.
- A **GitHub account** (you sign in with it).
- A **Claude subscription** or an **Anthropic API key** (you connect it in the setup page).
- A Claude or ChatGPT account to talk to it.

You do not need a domain name: bivouac uses `<your-ip>.sslip.io` out of the box and can switch to your own domain later.

## Install

On the server, as root (or with `sudo`):

<!-- e2e:install:start -->
```bash
curl -fsSL https://raw.githubusercontent.com/harijoe/bivouac/main/install.sh | sudo bash
```
<!-- e2e:install:end -->

There are no questions. The installer installs Docker if needed, starts bivouac, gets a certificate for `https://<ip-with-dashes>.sslip.io`, and prints a **one-time setup link** with a QR code:

```
  bivouac 0.2.0 is running. Open this link to finish the setup (it works once):

    https://203-0-113-7.sslip.io/setup?code=K7QM-4TXD
```

If the certificate cannot be obtained, the installer says exactly what to open in your provider's firewall (TCP 80 and 443) and how to retry.

## The setup page

Open the link (on your phone, scan the QR code). Five short steps, one thing per screen:

1. **Address**: keep the default, or enter your own domain (see [Your own domain](#your-own-domain)).
2. **GitHub**: bivouac creates a **private GitHub App that belongs only to you** (GitHub asks you to confirm its name). It is used to sign you in and to reach the repositories you pick. You become the administrator and the setup link is closed for good.
3. **Repositories**: choose which repositories the app may access, then add them as projects.
4. **Claude**: click *Connect Claude*, sign in on claude.ai, paste the code it shows you. (Or paste an Anthropic API key instead.) The token is stored encrypted and is valid for one year; the dashboard shows when it expires and has a *Renew* button.
5. **Chat**: copy the bivouac address into Claude or ChatGPT.

Lost the link or locked yourself out? On the server: `sudo bivouac reset-admin` prints a new one.

## Connect your chat

bivouac exposes an **MCP server** at `https://<your-address>/mcp`. Add it as a custom connector:

- **Claude (web or desktop)**: *Settings → Connectors → Add custom connector*, paste the address, *Connect*, sign in with GitHub, *Allow*.
- **Claude Code**: `claude mcp add --transport http bivouac https://<your-address>/mcp`, then `/mcp` inside Claude Code to sign in.
- **ChatGPT**: *Settings → Connectors → Advanced → Developer mode*, create a connector with the address and **OAuth** authentication.

Connected apps are listed in **Settings → Connected chat apps**, with a one-click *Disconnect*.

The tools your assistant gets: `list_projects`, `list_tasks`, `get_task`, `create_task`, `send_instruction`, `stop_task`, `resume_task`, `create_share_link`, `revoke_share_link`, `push_branch`, `open_pr`. Read-only tools are marked as such, so your chat app only asks for confirmation before actions that change something. `create_task` returns immediately; the assistant follows progress with `get_task`.

## Daily use

You: *“Using bivouac, in my-app, create a task `login-page`: add a login form with tests. Success means `pnpm test` passes.”*

Claude creates the task and gives you its preview address, `https://login-page.my-app.<your-address>`. Ask for news (“how is login-page going?”), give instructions (“use the existing Button component”), stop it, and when you are happy: “push the branch” or “open a PR”.

How a task works: the agent runs the official `claude` CLI in its container. When it stops, bivouac runs the **success command**; if it fails, the output goes back to the agent for another attempt, until it passes or a **budget** (attempts, dollars) is reached. Every task has a **name** (lowercase letters, digits, dashes; 1 to 40 characters, unique in its project). Names are never changed automatically: if one is taken you get a clear error and pick another.

The dashboard shows what is running, with status, preview, and cost; each task has the agent's progress, the last check, dev-server logs, share links, and actions: stop, resume, rename, delete. **Renaming** takes effect immediately without restarting the container; the git branch keeps its name, and existing share links stop working.

## Sharing a preview

Previews are **private by default**: without access you see a clear “Access denied” page.

- From the dashboard, *Open preview* gives you access through a one-time ticket.
- To show it to someone else, create a **share link** (1 hour, 24 hours, 7 days, or no expiry) from the task page or ask your assistant. A link opens that one preview only, and you can list and revoke links at any time.

## Project configuration (`bivouac.yml`)

Optional file at the root of a repository (the dashboard's *Default limits* and per-project overrides sit on top of it):

```yaml
setup: pnpm install            # runs once per task workspace
dev:
  command: pnpm dev --host 0.0.0.0
  port: 5173                   # the preview shows this port
success: pnpm test && pnpm build
limits: { cpus: 2, memory: 4g }
budget: { max_iterations: 10, max_cost_usd: 20 }
```

See [`examples/vite-app`](examples/vite-app) for a working project.

## Your own domain

In the setup page (or later in *Settings → More settings → Address*), enter a domain such as `bv.example.com`. bivouac shows the two DNS records to create at your registrar:

| Type | Name | Value |
|------|------|-------|
| A | `bv` | your server's IP |
| A | `*.bv` | your server's IP |

Click **Verify**: bivouac waits for the records, gets the certificate and moves you to the new address. Changing the domain later **recreates the GitHub App** (its URLs are tied to the domain) and **disconnects your chat connectors**: reconnect them with the new address. Preview certificates are issued per preview, on demand (HTTP-01), so no DNS provider access is needed. Let's Encrypt allows 50 new certificates per week per registered domain; a rename needs one.

## Security model

**What is public**: the sign-in page, the setup page (only with the one-time link), the OAuth endpoints, `/mcp` (requires a token), and previews (require a ticket or a share link). Everything else requires a session.

**Who can sign in**: only GitHub accounts you allow, identified by their **numeric GitHub id** (a login can be renamed or reused). The administrator can add people, or allow all members of an organisation or team. Sessions last 30 days (`HttpOnly`, `Secure`, `SameSite=Lax`, bound to the dashboard host). **Turn on two-factor authentication on your GitHub account**: it is the key to your server.

**Two services, one with Docker access**: the public `web` service has **no access to the Docker socket**; the `executor` service, which does, is reachable only from `web` on an internal Docker network, through a narrow authenticated API (start, stop, logs, run a command in a task container). A flaw in the public side does not give control of the machine.

**GitHub access**: for every git operation bivouac mints a short-lived token limited to **one repository** and the permissions needed (contents, pull requests). That token never enters a task container. Fine-grained personal tokens remain possible as an advanced option.

**Previews**: the code of a preview is written by an agent, so it is treated as untrusted. The dashboard cookie is never sent to previews (host-only cookie), the preview cookie is removed before the request reaches the app, and tickets are single-use.

**MCP**: OAuth 2.1 with PKCE (S256 only), dynamic client registration, one-hour access tokens, rotating refresh tokens (reuse revokes the connection), tokens stored hashed. Redirect URIs are limited to claude.ai, chatgpt.com and localhost. Authorization needs a signed-in user clicking *Allow*.

**Also**: rate limiting and temporary blocking on public endpoints, a strict Content-Security-Policy, an audit log (*Settings → Recent activity*), secrets encrypted at rest with a key outside the database.

**What an agent can reach**: its own container (non-root, no Docker socket, CPU and memory limits), its repository checkout, and the internet. It cannot see other tasks or the host. Agents run with permissions checks disabled inside their sandbox: give them only repositories you are comfortable with.

## Update and uninstall

**Update**: run the install command again. It keeps your data and settings, including from a 0.1.x installation (Tailscale is no longer used; the 0.1 database is migrated).

**Uninstall**: `sudo bash /opt/bivouac/uninstall.sh` removes the service and containers; add `--purge` to delete all data and the images.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The installer says it could not get a certificate | Open **TCP 80 and 443** in your provider's firewall (and `ufw allow 80,443/tcp` if the server has one), then run the installer again. |
| “Port 80/443 is already used” | Another web server runs on the machine. Stop it or move it, then run the installer again. |
| Lost the setup link / cannot sign in | `sudo bivouac reset-admin` prints a new link. |
| “This GitHub account is not allowed” | An administrator adds you in *Settings → Who can sign in*. |
| A task fails with a Claude error | *Settings → Claude → Renew* (tokens last a year). |
| `bivouac: command not found` | The installer did not finish; run it again. |
| A preview shows “Bad Gateway” | The dev server is not up yet or crashed: see *Dev server logs* in the task. |
| Preview certificate warning right after a rename | The certificate for the new address is being issued (a few seconds). |
| Chat app cannot connect | Check the address ends with `/mcp`, that it uses HTTPS, and that you signed in with an allowed GitHub account. |

Logs: `docker logs bivouac-web`, `docker logs bivouac-executor`, `docker logs bivouac-traefik`.

## About Claude subscriptions

bivouac runs the **official `claude` CLI** and signs in through `claude setup-token`; it does not reimplement the API. Usage counts as Claude Code usage on your subscription, and Anthropic's policy on this may change, which is why using an **Anthropic API key** is supported too.

## Development

```bash
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test    # unit tests, fake claude
pnpm test:integration                                      # real Docker + Traefik + the daemon image
node packages/daemon/dev/demo-server.mjs                   # the UI with demo data (no Docker)
node scripts/screenshots.mjs                               # 390 px and 1280 px screenshots of every screen
scripts/e2e-fresh-vps.sh [--real] [--domain] [--ghcr]      # end to end on a new Hetzner VM (needs HCLOUD_TOKEN)
```

Packages: `shared` (types, stream-json parser), `daemon` (web service, executor, CLI), `dashboard` (React), `task-image` (container image, fake claude).

## License

MIT
