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

## État final (2026-11-07)
- CI verte sur `main` (commit cfc746d: test, integration, images = success, lu via la branche `ci-status`). Release `v0.1.0` créée (tag + GitHub release). Les images `edge` sont publiées sur `ghcr.io/harijoe/bivouac-{daemon,task}`; celles de `0.1.0` sont construites par le workflow déclenché par le tag (non vérifié: lecture impossible, voir Q1/Q3).
- e2e VM neuve: fake x2 PASSED, vrai CLI PASSED (voir M7). Rien n'est resté chez Hetzner, aucun conteneur/réseau `bivouac-*` sur ce VPS.

## Définition de terminé — ce qui N'EST PAS satisfait
- `scripts/e2e-fresh-vps.sh` a passé deux fois, mais en mode « images construites sur la VM + install.sh local » à cause du repo privé (Q1). Le chemin documenté (`curl raw.githubusercontent.com | bash`, pull GHCR anonyme) n'a PAS été vérifié: `docker pull ghcr.io/harijoe/bivouac-daemon:edge` sans credentials répond `unauthorized`. Après décision sur Q1/Q3, lancer `scripts/e2e-fresh-vps.sh --ghcr` deux fois.
- Pour cette raison la ligne MISSION_TERMINEE n'est pas écrite.

## Limites connues
- Sidecars (Postgres/Redis) non implémentés; clé `image:` de bivouac.yml réservée (images dérivées de l'image de tâche uniquement).
- Previews publiques + basic auth: étiquettes Traefik générées et testées en unitaire, jamais testées sur un vrai accès public.
- Injection d'instructions: file d'attente appliquée à l'itération suivante (pas de `--input-format stream-json`).
- Le daemon monte le socket Docker (root-équivalent): protégé par Tailscale + token.
- TLS Let's Encrypt/Cloudflare écrit mais non testé de bout en bout.
- Coût d'une session `--resume`: supposé par invocation (cohérent avec le test réel: 0,044 $).
- Cas non testés: arm64 en conditions réelles, Ubuntu 22.04.

## Prochaines étapes suggérées
1. Trancher Q1/Q3 (repo public + packages GHCR publics), puis `e2e-fresh-vps.sh --ghcr` x2 et écrire MISSION_TERMINEE.
2. Tests TLS DNS-01, previews publiques, Ubuntu 22.04/arm64.
3. Sidecars de services par projet.

## Décisions
See docs/decisions.md.
