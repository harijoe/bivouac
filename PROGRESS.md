# PROGRESS

## BLOQUÉ / questions
- (Q1) Repo `harijoe/bivouac` is **private** → the documented `curl -fsSL https://raw.githubusercontent.com/...` install and the GHCR images cannot work anonymously from a fresh VM. Decision needed: make the repo public (and set the GHCR packages `bivouac-daemon` / `bivouac-task` to Public in the GitHub UI — there is no API for package visibility). Until then the e2e builds the images on the VM from the checkout (`BIVOUAC_SOURCE_DIR`) and uses the local copy of `install.sh`; the install command is still taken from the README.
- (Q2) The provided `GITHUB_TOKEN` cannot read Actions/Checks/Packages (403). Workaround: CI job `report` writes results (and the integration log) to branch `ci-status` (`status/latest.json`), readable with contents:read. Please double-check the Actions tab.
- (Q3) GHCR image publish + release `v0.1.0` can only be verified through that workaround; image *pulls* from a fresh VM need Q1.

## Fait
- M1: monorepo, task image (real CLI verified as non-root in the container with the OAuth token), real stream-json fixture.
- M2: daemon (SQLite store, runner / success loop, budgets, sandbox abstraction, host-side git, REST + SSE API): 24 unit tests with the fake claude.
- M3: Docker integration test (real Docker + Traefik v3.6 + fake claude): two parallel tasks on one project, previews through Traefik on distinct hostnames, live update of a file visible in the preview of that task only, cleanup. Passes locally.
- M4: dashboard (React/Vite, SSE, responsive; screenshots in docs/screenshots, no horizontal overflow at 390px).
- M6: `install.sh`, `uninstall.sh`, systemd unit, compose generation, GHCR workflow (written, see Q3).
- M7: `scripts/e2e-fresh-vps.sh` + `scripts/e2e-verify.sh`. Results on fresh Hetzner cx23 / Ubuntu 24.04 VMs (Tailscale joined with TS_AUTHKEY, images built on the VM, install command taken from the README):
  - fake claude run #1: PASSED; run #2 (new VM): PASSED. Each covers health, dashboard, auth, no public listener, 2 parallel tasks with previews over sslip.io, success loop (task 2 needs 2 iterations), non-root/no docker.sock, independent files, totals, task delete cleanup, idempotent re-install, uninstall --purge.
  - real claude run: PASSED (task succeeded, cost $0.044, preview contains the new button, tool calls and usage recorded).
  - Hetzner servers/keys: all destroyed after each run (0 left).
- README written (install command delimited by `e2e:install` markers so the e2e executes it verbatim).

## En cours
- CI green on main (integration job failing in CI, investigating via ci-status logs).
- e2e on a fresh Hetzner VM (x2), then real-CLI pass, then release v0.1.0.

## Décisions
See docs/decisions.md.
